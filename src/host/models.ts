import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProgramError } from '../runtime/protocol.js';
import {
  parseModelSelection, parseModelSlotId, parseModelsDeclaration, modelSelectionsEqual, MODEL_SLOT_LIMITS,
  type ModelSelection, type ModelsDeclaration, type ModelSlotView,
} from '../models.js';

export interface ModelScope { ownerId: string; program: string }
export interface ProgramModelStoreOptions { maxRows?: number }
interface Row {
  owner_id: string; program: string; slot: string; description: string;
  default_selection: string; override_selection: string | null;
  revision: number; declared: number;
}
/** Durable preferences belong to a parent/program, never a run generation.
 * The store validates shape only: trusted Host setters must validate adapter
 * availability/efforts before committing, and programs never receive setters. */
export class ProgramModelStore {
  private readonly db: DatabaseSync;
  private readonly maxRows: number;
  private closed = false;
  constructor(path: string, options: ProgramModelStoreOptions = {}) {
    this.maxRows = options.maxRows ?? 10_000;
    if (!Number.isSafeInteger(this.maxRows) || this.maxRows < 1 || this.maxRows > 100_000) throw new ProgramError('INVALID_CONFIG', 'Invalid model slot store limit');
    if (path !== ':memory:') { path = resolve(path); mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); }
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 1000;
      CREATE TABLE IF NOT EXISTS program_model_slots (
        owner_id TEXT NOT NULL, program TEXT NOT NULL, slot TEXT NOT NULL,
        description TEXT NOT NULL, default_selection TEXT NOT NULL,
        override_selection TEXT, revision INTEGER NOT NULL, declared INTEGER NOT NULL,
        PRIMARY KEY (owner_id,program,slot)
      );`);
  }
  /** Replace app-owned metadata while retaining every human-owned override.
   * Removed declarations become tombstones so a later redeclaration restores
   * the preference and cannot reuse a stale revision from the previous slot. */
  declare(scope: ModelScope, input: ModelsDeclaration | unknown): ModelSlotView[] {
    this.checkScope(scope);
    const declarations = parseModelsDeclaration(input);
    return this.transaction(() => {
      const existing = this.rows(scope), byId = new Map(existing.map(row => [row.slot, row]));
      const additions = Object.keys(declarations).filter(id => !byId.has(id)).length;
      const total = (this.db.prepare('SELECT count(*) AS count FROM program_model_slots').get() as { count: number }).count;
      if (total + additions > this.maxRows) throw new ProgramError('BACKPRESSURE', 'Model slot store is full');
      for (const row of existing) if (row.declared && !Object.hasOwn(declarations, row.slot)) {
        this.db.prepare('UPDATE program_model_slots SET declared=0,revision=? WHERE owner_id=? AND program=? AND slot=?').run(this.nextRevision(row.revision), scope.ownerId, scope.program, row.slot);
      }
      for (const [id, declaration] of Object.entries(declarations)) {
        const row = byId.get(id);
        if (!row) {
          this.db.prepare('INSERT INTO program_model_slots (owner_id,program,slot,description,default_selection,override_selection,revision,declared) VALUES (?,?,?,?,?,NULL,1,1)').run(scope.ownerId, scope.program, id, declaration.description, JSON.stringify(declaration.default));
        } else if (!row.declared || row.description !== declaration.description || !modelSelectionsEqual(parseModelSelection(JSON.parse(row.default_selection)), declaration.default)) {
          this.db.prepare('UPDATE program_model_slots SET description=?,default_selection=?,declared=1,revision=? WHERE owner_id=? AND program=? AND slot=?').run(declaration.description, JSON.stringify(declaration.default), this.nextRevision(row.revision), scope.ownerId, scope.program, id);
        }
      }
      const views = this.list(scope);
      this.checkSnapshot(views);
      return views;
    });
  }
  list(scope: ModelScope): ModelSlotView[] {
    this.checkScope(scope);
    return this.rows(scope).filter(row => row.declared).map(row => this.view(row));
  }
  get(scope: ModelScope, id: string): ModelSlotView {
    this.checkScope(scope); parseModelSlotId(id);
    const row = this.row(scope, id);
    if (!row?.declared) throw new ProgramError('NOT_FOUND', 'Model slot is not declared for this program');
    return this.view(row);
  }
  resolve(scope: ModelScope, id: string): ModelSelection { return this.get(scope, id).selection; }
  /** Human-facing trusted Host operation only. Undefined resets to the default.
   * Even a no-op validates the revision, preventing stale browser writes. */
  set(scope: ModelScope, id: string, selection: ModelSelection | undefined, expectedRevision: number): ModelSlotView {
    this.checkScope(scope); parseModelSlotId(id);
    const normalized = selection === undefined ? undefined : parseModelSelection(selection);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new ProgramError('INVALID_INPUT', 'Invalid model slot revision');
    return this.transaction(() => {
      const row = this.row(scope, id);
      if (!row?.declared) throw new ProgramError('NOT_FOUND', 'Model slot is not declared for this program');
      if (row.revision !== expectedRevision) throw new ProgramError('CONFLICT', 'Model slot changed; use the latest revision');
      const previous = row.override_selection === null ? undefined : parseModelSelection(JSON.parse(row.override_selection));
      if (!modelSelectionsEqual(previous, normalized)) {
        this.db.prepare('UPDATE program_model_slots SET override_selection=?,revision=? WHERE owner_id=? AND program=? AND slot=?').run(normalized === undefined ? null : JSON.stringify(normalized), this.nextRevision(row.revision), scope.ownerId, scope.program, id);
      }
      this.checkSnapshot(this.list(scope));
      return this.get(scope, id);
    });
  }
  setOverride(scope: ModelScope, id: string, selection: ModelSelection, expectedRevision: number): ModelSlotView { return this.set(scope, id, selection, expectedRevision); }
  reset(scope: ModelScope, id: string, expectedRevision: number): ModelSlotView { return this.set(scope, id, undefined, expectedRevision); }
  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }
  private row(scope: ModelScope, id: string): Row | undefined {
    return this.db.prepare('SELECT * FROM program_model_slots WHERE owner_id=? AND program=? AND slot=?').get(scope.ownerId, scope.program, id) as unknown as Row | undefined;
  }
  private rows(scope: ModelScope): Row[] {
    return this.db.prepare('SELECT * FROM program_model_slots WHERE owner_id=? AND program=? ORDER BY slot').all(scope.ownerId, scope.program) as unknown as Row[];
  }
  private view(row: Row): ModelSlotView {
    const defaultSelection = parseModelSelection(JSON.parse(row.default_selection));
    return { id: row.slot, description: row.description, default: defaultSelection, selection: row.override_selection === null ? { ...defaultSelection } : parseModelSelection(JSON.parse(row.override_selection)), overridden: row.override_selection !== null, revision: row.revision };
  }
  private checkScope(scope: ModelScope): void {
    if (this.closed) throw new ProgramError('CLOSED', 'Model slot store is closed');
    if (!scope || [scope.ownerId, scope.program].some(value => typeof value !== 'string' || !value || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value))) throw new ProgramError('INVALID_INPUT', 'Invalid model slot scope');
  }
  private checkSnapshot(views: ModelSlotView[]): void {
    if (Buffer.byteLength(JSON.stringify(views)) > MODEL_SLOT_LIMITS.snapshotBytes) throw new ProgramError('LIMIT', 'Model slot snapshot exceeds 56 KiB');
  }
  private nextRevision(value: number): number {
    if (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) throw new ProgramError('LIMIT', 'Model slot revision limit reached');
    return value + 1;
  }
  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
