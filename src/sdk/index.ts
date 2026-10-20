/**
 * Preferred entrypoint: export default async function main(ctx) from a configured
 * .js/.mjs/.ts module. The supervisor imports it in its process bootstrap.
 * runProgram is optional for standalone IPC-managed modules; it never starts a
 * model loop and throws outside an actual child IPC connection.
 */
export type { ProgramContext, ProgramMain, JsonValue, CapabilityMetadata } from '../types.js';
export { standaloneRun as runProgram } from './connection.js';
