import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Context } from '@deepseek-ai/cordis';
import { BUNDLED_SKILL_RANK, type SkillDefinition, type SkillProvider } from '@deepseek-ai/dsh-skill';
import { parse as parseYaml } from 'yaml';
import { object } from './validation.js';

const name = 'program-agents';
// Both src/host and dist/host sit two levels below the package root. The
// bundled host entries keep this same layout, including after npm installation.
const directory = new URL('../../skills/program-agents/', import.meta.url);
const path = fileURLToPath(new URL('SKILL.md', directory));
const resourceBase = { kind: 'directory', path: fileURLToPath(directory) } as const;

async function definition(): Promise<SkillDefinition> {
  const raw = await readFile(path, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(raw);
  if (!match) throw new Error(`Missing skill frontmatter: ${path}`);
  const metadata = object(parseYaml(match[1]!));
  if (metadata.name !== name || typeof metadata.description !== 'string' || !metadata.description.trim()) {
    throw new Error(`Invalid bundled skill name or description: ${path}`);
  }
  for (const key of ['disable-model-invocation', 'user-invocable']) {
    if (metadata[key] !== undefined && typeof metadata[key] !== 'boolean') throw new Error(`Invalid ${key} in ${path}`);
  }
  return {
    name, description: metadata.description, path, resourceBase, metadata,
    provider: name, source: 'bundled', content: match[2]!,
    invocation: {
      modelInvocable: metadata['disable-model-invocation'] !== true,
      userInvocable: metadata['user-invocable'] !== false,
    },
  };
}

const provider: SkillProvider = {
  name,
  async list() {
    const { content: _content, ...skill } = await definition();
    return [{ ...skill, rank: BUNDLED_SKILL_RANK, locator: path }];
  },
  get: () => definition(),
};

export function registerBundledSkill(ctx: Context): void {
  ctx.skills.registerProvider(() => provider);
}
