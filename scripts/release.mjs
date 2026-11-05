import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const { name, version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const directory = join(root, '.state', 'npm-release');
const archive = join(directory, `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`);
const [action, ...args] = process.argv.slice(2);
const commands = {
  pack: ['pnpm', ['pack', '--pack-destination', directory, ...args]],
  inspect: ['tar', ['-tzf', archive, ...args]],
  publish: ['pnpm', ['publish', archive, '--access', 'public', ...args]],
};

if (!Object.hasOwn(commands, action)) {
  console.error('Usage: node scripts/release.mjs <pack|inspect|publish> [options]');
  process.exit(1);
}
if (action !== 'pack' && !existsSync(archive)) {
  console.error(`No release archive for ${name}@${version}. Run pnpm release:pack first.`);
  process.exit(1);
}

const [command, commandArgs] = commands[action];
const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
