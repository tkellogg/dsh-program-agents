/** Browser-safe named model-slot contracts. Routes are adapter-owned opaque ids. */
export interface ModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}
export interface ModelSlotDeclaration {
  /** Why this program uses the slot, shown beside its editable selection. */
  description: string;
  default: ModelSelection;
}
export type ModelsDeclaration = Record<string, ModelSlotDeclaration>;
export interface ModelSlotView extends ModelSlotDeclaration {
  id: string;
  /** User override when present, otherwise the latest declared default. */
  selection: ModelSelection;
  overridden: boolean;
  /** Optimistic-concurrency fence for declaration and preference changes. */
  revision: number;
}
export const MODEL_SLOT_LIMITS = { slots: 32, id: 120, description: 1_200, route: 512, declarationBytes: 48 * 1024, snapshotBytes: 56 * 1024 } as const;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unknown model selection field');
}
function text(value: unknown, field: string, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`Invalid model ${field}`);
  return value;
}
export function parseModelSlotId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/.test(value)) throw new Error('Invalid model slot id');
  return value;
}
/** Copy and validate wire input without retaining caller-owned objects. */
export function parseModelSelection(value: unknown): ModelSelection {
  if (!record(value)) throw new Error('Invalid model selection');
  keys(value, ['provider', 'model', 'reasoningEffort']);
  return {
    provider: text(value.provider, 'provider', MODEL_SLOT_LIMITS.route),
    model: text(value.model, 'model', MODEL_SLOT_LIMITS.route),
    ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: text(value.reasoningEffort, 'reasoning effort', MODEL_SLOT_LIMITS.route) }),
  };
}
/** A declaration is a complete snapshot, not a merge or a preference mutation. */
export function parseModelsDeclaration(value: unknown): ModelsDeclaration {
  if (!record(value)) throw new Error('Invalid model slot declarations');
  const entries = Object.entries(value);
  if (entries.length > MODEL_SLOT_LIMITS.slots) throw new Error('At most 32 model slots per program');
  const result: ModelsDeclaration = Object.create(null) as ModelsDeclaration;
  for (const [id, raw] of entries) {
    parseModelSlotId(id);
    if (!record(raw)) throw new Error('Invalid model slot declaration');
    keys(raw, ['description', 'default']);
    result[id] = { description: text(raw.description, 'slot description', MODEL_SLOT_LIMITS.description), default: parseModelSelection(raw.default) };
  }
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MODEL_SLOT_LIMITS.declarationBytes) throw new Error('Model slot declarations exceed 48 KiB');
  return result;
}
export function modelSelectionsEqual(left: ModelSelection | undefined, right: ModelSelection | undefined): boolean {
  return left === right || left !== undefined && right !== undefined && left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort;
}
