import type { JsonValue } from '../types.js';
import type { CallOptions } from './index.js';
import { parseModelsDeclaration, parseModelSlotId, type ModelsDeclaration, type ModelSelection, type ModelSlotView } from '../models.js';
export type { ModelSelection, ModelSlotDeclaration, ModelsDeclaration, ModelSlotView } from '../models.js';
export type ModelBridgeCall = <T = JsonValue>(method: string, input?: JsonValue, options?: CallOptions) => Promise<T>;
export interface ModelCallControls {
  prompt: string;
  system?: string;
  maxTokens?: number;
}
/** Slot calls use its complete selection; explicit calls remain independent. */
export type ProgramModelCallInput = ModelCallControls & (
  | { slot: string; provider?: never; model?: never; reasoningEffort?: never }
  | (ModelSelection & { slot?: never })
);
export interface ProgramModels {
  /** Publish a complete declaration snapshot without overwriting user overrides. */
  declare(slots: ModelsDeclaration, options?: CallOptions): Promise<ModelSlotView[]>;
  list(options?: CallOptions): Promise<ModelSlotView[]>;
  /** Resolve the current preference at call time, across watch/run generations. */
  resolve(slot: string, options?: CallOptions): Promise<ModelSelection>;
  /** Alias of resolve: returns the route, not the slot's editable metadata. */
  get(slot: string, options?: CallOptions): Promise<ModelSelection>;
  /** Exactly one explicit model call. No inference, tools, or fallback loop is implicit. */
  call<T = JsonValue>(input: ProgramModelCallInput | JsonValue, options?: CallOptions): Promise<T>;
}
/** The app face intentionally has no setter/resetter for human-owned preferences. */
export function createProgramModels(call: ModelBridgeCall): ProgramModels {
  const resolve = (slot: string, options?: CallOptions) => call<ModelSelection>('models.resolve', { slot: parseModelSlotId(slot) }, options);
  return {
    declare: (slots, options) => call<ModelSlotView[]>('models.declare', { slots: parseModelsDeclaration(slots) } as unknown as JsonValue, options),
    list: options => call<ModelSlotView[]>('models.list', {}, options),
    resolve,
    get: resolve,
    call: <T = JsonValue>(input: ProgramModelCallInput | JsonValue, options?: CallOptions) => call<T>('models.call', input as JsonValue, options),
  };
}
