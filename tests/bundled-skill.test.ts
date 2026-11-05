import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Context, type Fiber } from '@deepseek-ai/cordis';
import { SkillRegistry, renderSkillContent, type SkillDefinition } from '@deepseek-ai/dsh-skill';
import { parse as parseYaml } from 'yaml';
import * as plugin from '../src/host/index.js';

const project = fileURLToPath(new URL('../', import.meta.url));

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'program-bundled-skill-')));
  const root = new Context();
  const fibers: Fiber[] = [];
  root.provide('tools', { register() { return () => {}; } });
  root.provide('agents', { get() { return undefined; } });
  root.provide('llm', {});
  t.after(async () => {
    for (const fiber of fibers.reverse()) await fiber.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  return { root, directory, fibers };
}

async function verifySkill(root: Context, skillRoot: string) {
  const summaries = await root.skills.list();
  assert.deepEqual(summaries.map(skill => skill.name), ['program-agents']);
  const skill = await root.skills.get('program-agents');
  assert.ok(skill);
  const raw = await readFile(join(skillRoot, 'SKILL.md'), 'utf8');
  const [, frontmatter, body] = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(raw)!;
  assert.equal(skill.description, parseYaml(frontmatter).description);
  assert.equal(skill.content, body);
  assert.equal(skill.source, 'bundled');
  assert.equal(skill.provider, 'program-agents');
  assert.equal(skill.path, join(skillRoot, 'SKILL.md'));
  assert.deepEqual(skill.invocation, { modelInvocable: true, userInvocable: true });
  assert.equal(skill.resourceBase?.kind, 'directory');
  assert.equal(await realpath((skill.resourceBase as { path: string }).path), await realpath(skillRoot));
  assert.ok(renderSkillContent(skill).includes(skillRoot), 'DSH tells the agent where to resolve supporting files');
  assert.match(await readFile(join(skillRoot, 'endpoints.md'), 'utf8'), /endpoints/i);
  assert.match(await readFile(join(skillRoot, 'references/chat-sidebar/backend.ts'), 'utf8'), /Hono/);
}

test('host discovers the bundled skill when the optional registry arrives and cleans up on unload', async t => {
  const { root, directory, fibers } = await fixture(t);
  const host = await root.plugin(plugin, { auditDirectory: directory, programs: {} });
  fibers.push(host);
  assert.ok(root.programAgents, 'program tools still load without a skills service');
  fibers.push(await root.plugin(SkillRegistry));
  const skillRoot = join(await realpath(project), 'skills/program-agents');
  await verifySkill(root, skillRoot);
  await host.dispose();
  assert.deepEqual(await root.skills.list(), []);
  assert.equal(await root.skills.get('program-agents'), undefined);
  fibers.push(await root.plugin(plugin, { auditDirectory: directory, programs: {} }));
  await verifySkill(root, skillRoot);
});

test('user skills override the bundled skill and removing an override restores it', async t => {
  const { root, directory, fibers } = await fixture(t);
  fibers.push(await root.plugin(SkillRegistry));
  fibers.push(await root.plugin(plugin, { auditDirectory: directory, programs: {} }));
  const userSkill: SkillDefinition = {
    name: 'program-agents', description: 'My custom instructions', content: 'Local override',
    source: 'user-dsh', provider: 'user-fixture',
    invocation: { modelInvocable: true, userInvocable: true },
  };
  const override = await root.plugin({
    name: 'user-skill-fixture',
    inject: ['skills'],
    apply(ctx) {
      ctx.skills.registerProvider(() => ({
        name: 'user-fixture',
        list: async () => [{ ...userSkill, rank: 400, locator: 'user' }],
        get: async () => userSkill,
      }));
    },
  });
  fibers.push(override);
  assert.equal((await root.skills.get('program-agents'))?.content, 'Local override');
  assert.equal((await root.skills.list())[0]?.source, 'user-dsh');
  await override.dispose();
  await verifySkill(root, join(await realpath(project), 'skills/program-agents'));
});

test('npm archive discovers its own skill and supporting files after extraction', {
  skip: !existsSync(join(project, 'dist/host/skills.js')) && 'Run pnpm build before testing the npm archive',
}, async t => {
  const { root, directory, fibers } = await fixture(t);
  // Disable hooks here: prepack itself runs this test through pnpm check.
  execFileSync('pnpm', ['pack', '--config.ignore-scripts=true', '--pack-destination', directory], {
    cwd: project, stdio: 'pipe', timeout: 30000,
  });
  const archives = (await readdir(directory)).filter(file => file.endsWith('.tgz'));
  assert.equal(archives.length, 1);
  execFileSync('tar', ['-xzf', join(directory, archives[0]!), '-C', directory]);
  // Reuse installed peer dependencies without relying on the source checkout's
  // location for any packaged code or skill resources.
  await symlink(join(project, 'node_modules'), join(directory, 'node_modules'), 'dir');
  const installed = await import(pathToFileURL(join(directory, 'package/dist/host/index.js')).href);
  fibers.push(await root.plugin(SkillRegistry));
  const host = await root.plugin(installed, { auditDirectory: join(directory, 'audit'), programs: {} });
  fibers.push(host);
  await verifySkill(root, join(directory, 'package/skills/program-agents'));
  await host.dispose();
  assert.equal(await root.skills.get('program-agents'), undefined);
});
