import type { AuditAction, AuditEntry, AuditNote, Role } from '../../../shared/src/types.js';
import type { AppState } from '../store/state.js';
import { MAX_AUDIT_ENTRIES } from '../store/state.js';

export interface RecordInput {
  action: AuditAction;
  actor: Role;
  target: string;
  summary: string;
  changes?: AuditEntry['changes'];
}

let counter = 0;

/**
 * Appends one entry to the audit trail, newest first.
 *
 * Entries are stamped with wall-clock time rather than the simulated market
 * clock: the trail records when a person did something, which is a different
 * question from where the simulation had got to.
 */
export function record(state: AppState, input: RecordInput): AuditEntry {
  counter += 1;
  const entry: AuditEntry = {
    id: `aud_${Date.now().toString(36)}_${counter.toString(36)}`,
    action: input.action,
    actor: input.actor,
    at: new Date().toISOString(),
    target: input.target,
    summary: input.summary,
    changes: input.changes?.length ? input.changes : undefined,
    notes: [],
  };

  state.audit.unshift(entry);
  if (state.audit.length > MAX_AUDIT_ENTRIES) state.audit.length = MAX_AUDIT_ENTRIES;
  return entry;
}

export function addNote(entry: AuditEntry, author: Role, text: string): AuditNote {
  counter += 1;
  const note: AuditNote = {
    id: `not_${Date.now().toString(36)}_${counter.toString(36)}`,
    author,
    text,
    createdAt: new Date().toISOString(),
  };
  entry.notes.push(note);
  return note;
}

export interface AuditQuery {
  action?: AuditAction;
  actor?: Role;
  /** Case-insensitive match against target, summary and note text. */
  search?: string;
  /** Only entries that carry at least one review note. */
  notedOnly?: boolean;
  limit?: number;
}

export function queryAudit(state: AppState, query: AuditQuery): AuditEntry[] {
  const needle = query.search?.trim().toLowerCase();
  const rows = state.audit.filter((entry) => {
    if (query.action && entry.action !== query.action) return false;
    if (query.actor && entry.actor !== query.actor) return false;
    if (query.notedOnly && entry.notes.length === 0) return false;
    if (needle) {
      const haystack = [entry.target, entry.summary, ...entry.notes.map((n) => n.text)]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
  return rows.slice(0, query.limit ?? 200);
}

/** Describes what changed between two settings objects, for the trail. */
export function diffFields<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
  format: Partial<Record<keyof T, (value: unknown) => string>> = {},
): AuditEntry['changes'] {
  const changes: NonNullable<AuditEntry['changes']> = [];
  for (const key of Object.keys(after) as Array<keyof T>) {
    const from = before[key];
    const to = after[key];
    if (to === undefined || Object.is(from, to)) continue;
    const show = format[key] ?? ((value: unknown) => String(value));
    changes.push({ field: String(key), from: show(from), to: show(to) });
  }
  return changes;
}

const CSV_COLUMNS = ['Time', 'Actor', 'Action', 'Target', 'Summary', 'Changes', 'Notes'] as const;

/** A leading =, +, - or @ makes a spreadsheet evaluate the cell as a formula. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;
/** …but a plain negative number legitimately starts with "-", and a numeric
 *  column full of quoted text would be useless to the reviewer. */
const PLAIN_NUMBER = /^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/;

/** Escapes one CSV field: quote it, and double any quote inside. A value that
 *  would otherwise be executed as a formula is prefixed with an apostrophe so
 *  the spreadsheet treats it as text — numbers are left alone. */
export function csvCell(value: string): string {
  const guarded =
    FORMULA_LEAD.test(value) && !PLAIN_NUMBER.test(value) ? `'${value}` : value;
  return `"${guarded.replace(/"/g, '""')}"`;
}

export function auditToCsv(entries: AuditEntry[]): string {
  const lines = [CSV_COLUMNS.map(csvCell).join(',')];
  for (const entry of entries) {
    lines.push(
      [
        entry.at,
        entry.actor,
        entry.action,
        entry.target,
        entry.summary,
        (entry.changes ?? []).map((c) => `${c.field}: ${c.from} -> ${c.to}`).join('; '),
        entry.notes.map((n) => `[${n.author}] ${n.text}`).join('; '),
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

export function rowsToCsv(headers: string[], rows: Array<Array<string | number>>): string {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map((cell) => csvCell(String(cell))).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
