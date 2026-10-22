import type { NoteDecisionResult, NoteDecisionSource } from './noteDecision';

export type NoteField = 'category' | 'account';
export interface NoteDraftSnapshot {
  note: string;
  type: string;
  occurredAt: number;
  categoryId?: number;
  accountId?: number;
}
type Patch = Partial<Pick<NoteDraftSnapshot, 'categoryId' | 'accountId'>>;
interface Host {
  read(): NoteDraftSnapshot;
  request(draft: NoteDraftSnapshot, signal: AbortSignal, sources: Record<NoteField, NoteDecisionSource>): Promise<NoteDecisionResult>;
  apply(patch: Patch): void;
  notify(fields: NoteField[]): void;
}
const fields = ['category', 'account'] as const;
const inputKey = (draft: NoteDraftSnapshot) => JSON.stringify([draft.note.trim(), draft.type, draft.occurredAt]);
const snapshotKey = (draft: NoteDraftSnapshot) => JSON.stringify([inputKey(draft), draft.categoryId, draft.accountId]);

/** One unsaved draft only. A response never saves a bill or overrides a newer user action. */
export class NoteDecisionSession {
  private controller?: AbortController;
  private revision = 0;
  private closed = false;
  private completed: string;
  private undoFields: Partial<Record<NoteField, { before?: number; after: number }>> = {};
  private sources: Record<NoteField, NoteDecisionSource>;

  constructor(private readonly host: Host, sources: Record<NoteField, NoteDecisionSource>) {
    this.sources = { ...sources };
    this.completed = inputKey(host.read());
  }
  private abort() { this.revision++; this.controller?.abort(); this.controller = undefined; }
  invalidate() { this.abort(); this.undoFields = {}; this.host.notify([]); }
  repeat() {
    if (this.closed) return;
    this.invalidate();
    this.sources = { category: 'copied', account: 'copied' };
    this.completed = inputKey(this.host.read());
  }
  dispose() { this.closed = true; this.invalidate(); }
  manual(field: NoteField) {
    this.abort(); this.sources[field] = 'manual'; delete this.undoFields[field];
    this.host.notify(fields.filter(key => !!this.undoFields[key]));
  }
  async complete(): Promise<void> {
    const draft = this.host.read(), key = inputKey(draft);
    if (this.closed || !draft.note.trim() || !['expense', 'income'].includes(draft.type) || key === this.completed
      || fields.every(field => this.sources[field] === 'manual')) return;
    this.invalidate(); this.completed = key;
    const revision = this.revision, controller = new AbortController(); this.controller = controller;
    try {
      const result = await this.host.request(draft, controller.signal, { ...this.sources });
      if (this.closed || controller.signal.aborted || revision !== this.revision || snapshotKey(draft) !== snapshotKey(this.host.read())) return;
      const patch: Patch = {};
      for (const field of fields) {
        const suggestion = result[field], idKey = `${field}Id` as const;
        if (!suggestion?.automatic || this.sources[field] === 'manual' || suggestion.id === draft[idKey]) continue;
        this.undoFields[field] = { before: draft[idKey], after: suggestion.id };
        patch[idKey] = suggestion.id; this.sources[field] = 'model';
      }
      if (Object.keys(patch).length) this.host.apply(patch);
      this.host.notify(fields.filter(field => !!this.undoFields[field]));
    } catch {
      if (!this.closed && revision === this.revision) this.host.notify([]);
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }
  }
  undo() {
    this.abort();
    const draft = this.host.read(), patch: Patch = {};
    for (const field of fields) {
      const previous = this.undoFields[field], key = `${field}Id` as const;
      if (!previous || this.sources[field] === 'manual' || draft[key] !== previous.after) continue;
      patch[key] = previous.before; this.sources[field] = 'manual';
    }
    this.undoFields = {};
    if (Object.keys(patch).length) this.host.apply(patch);
    this.host.notify([]);
  }
}
