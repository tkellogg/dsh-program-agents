import type { CapabilityDefinition, CapabilityMetadata } from '../types.js';
import { assertJson, jsonClone, ProgramError, validName } from './protocol.js';

/** Host-owned capability handlers; children only ever see allowlisted metadata. */
export class CapabilityRegistry {
  private readonly entries = new Map<string, CapabilityDefinition>();

  register(definition: CapabilityDefinition): () => void {
    if (!validName(definition.name) || ['parent.send', 'status.set', 'resources.publish', 'resources.unpublish', 'capabilities.list'].includes(definition.name)) {
      throw new ProgramError('INVALID_CAPABILITY', 'Invalid or reserved capability name');
    }
    if (typeof definition.description !== 'string' || definition.description.length > 4096 || typeof definition.handler !== 'function') {
      throw new ProgramError('INVALID_CAPABILITY', 'Capability requires a bounded description and handler');
    }
    if (definition.inputSchema !== undefined) assertJson(definition.inputSchema);
    if (this.entries.has(definition.name)) throw new ProgramError('DUPLICATE_CAPABILITY', `Capability already registered: ${definition.name}`);
    const entry: CapabilityDefinition = {
      name: definition.name,
      description: definition.description,
      ...(definition.inputSchema === undefined ? {} : { inputSchema: jsonClone(definition.inputSchema) }),
      handler: definition.handler,
    };
    this.entries.set(entry.name, entry);
    return () => { if (this.entries.get(entry.name) === entry) this.entries.delete(entry.name); };
  }

  list(): CapabilityMetadata[] {
    return [...this.entries.values()].map(({ name, description, inputSchema }) => ({
      name,
      description,
      ...(inputSchema === undefined ? {} : { inputSchema: jsonClone(inputSchema) }),
    }));
  }

  get(name: string): CapabilityDefinition | undefined {
    const entry = this.entries.get(name);
    return entry && { ...entry, ...(entry.inputSchema === undefined ? {} : { inputSchema: jsonClone(entry.inputSchema) }) };
  }
}
