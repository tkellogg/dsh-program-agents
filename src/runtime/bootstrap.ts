import { pathToFileURL } from 'node:url';
import { beginRegistration, ChildConnection, endRegistration } from '../sdk/connection.js';
import type { ProgramMain } from '../types.js';

// This file is the fork target, not a general-purpose REPL. The supervisor alone
// chooses this already-configured entrypoint; no code or identity comes from tools.
const entry = process.argv[2];
const connection = new ChildConnection();
void connection.execute(async () => {
  if (!entry) throw new Error('Missing configured program entrypoint');
  process.argv = [process.execPath, entry, ...process.argv.slice(3)];
  const registration = beginRegistration();
  try {
    const module: { default?: ProgramMain } = await import(pathToFileURL(entry).href);
    const main = module.default ?? registration.main;
    if (module.default && registration.main) throw new Error('Use either default main(ctx) or runProgram(main), not both');
    if (typeof main !== 'function') throw new Error('Program must export default main(ctx)');
    return main;
  } finally { endRegistration(); }
});
