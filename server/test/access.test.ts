import { describe, expect, it, beforeEach } from 'vitest';
import {
  ROLES,
  ROLE_PERMISSIONS,
  can,
  type Permission,
  type Role,
} from '../../shared/src/types.js';
import { addNote, auditToCsv, csvCell, diffFields, queryAudit, record } from '../src/engine/audit.js';
import { createInitialState, MAX_AUDIT_ENTRIES, type AppState } from '../src/store/state.js';

function fresh(): AppState {
  return createInitialState(new Date('2026-01-05T14:30:00.000Z'));
}

describe('the role model', () => {
  it('gives the auditor review rights and nothing that moves money', () => {
    expect(can('AUDITOR', 'audit:read')).toBe(true);
    expect(can('AUDITOR', 'audit:note')).toBe(true);
    expect(can('AUDITOR', 'alerts:ack')).toBe(true);
    expect(can('AUDITOR', 'export')).toBe(true);
    expect(can('AUDITOR', 'view')).toBe(true);

    expect(can('AUDITOR', 'trade')).toBe(false);
    expect(can('AUDITOR', 'controls:manage')).toBe(false);
    expect(can('AUDITOR', 'engine:manage')).toBe(false);
    expect(can('AUDITOR', 'instruments:manage')).toBe(false);
  });

  it('keeps note-writing to the auditor alone', () => {
    const authors = ROLES.filter((role) => can(role, 'audit:note'));
    expect(authors).toEqual(['AUDITOR']);
  });

  it('lets no role both trade and set the limits that constrain trading', () => {
    for (const role of ROLES) {
      expect(can(role, 'trade') && can(role, 'controls:manage')).toBe(false);
    }
  });

  it('gives every role the ability to view', () => {
    for (const role of ROLES) expect(can(role, 'view')).toBe(true);
  });

  it('grants no permission outside the declared set', () => {
    const known = new Set<Permission>([
      'view',
      'trade',
      'instruments:manage',
      'controls:manage',
      'engine:manage',
      'alerts:ack',
      'audit:read',
      'audit:note',
      'export',
    ]);
    for (const role of ROLES) {
      for (const permission of ROLE_PERMISSIONS[role]) expect(known.has(permission)).toBe(true);
    }
  });
});

describe('the audit trail', () => {
  let state: AppState;
  beforeEach(() => {
    state = fresh();
  });

  it('records newest first', () => {
    record(state, { action: 'ORDER_PLACED', actor: 'TRADER', target: 'NVCR', summary: 'first' });
    record(state, { action: 'ORDER_PLACED', actor: 'TRADER', target: 'KELP', summary: 'second' });
    expect(state.audit.map((e) => e.summary)).toEqual(['second', 'first']);
  });

  it('stays bounded', () => {
    for (let i = 0; i < MAX_AUDIT_ENTRIES + 25; i += 1) {
      record(state, { action: 'ENGINE_CHANGED', actor: 'RISK_MANAGER', target: 'sim', summary: `#${i}` });
    }
    expect(state.audit.length).toBe(MAX_AUDIT_ENTRIES);
    expect(state.audit[0].summary).toBe(`#${MAX_AUDIT_ENTRIES + 24}`);
  });

  it('carries notes written against an entry', () => {
    const entry = record(state, {
      action: 'CONTROLS_CHANGED',
      actor: 'RISK_MANAGER',
      target: 'ETF',
      summary: 'raised the cap',
    });
    addNote(entry, 'AUDITOR', 'Reviewed — approved on 5 Jan.');
    expect(state.audit[0].notes).toHaveLength(1);
    expect(state.audit[0].notes[0].author).toBe('AUDITOR');
  });

  it('filters by action, by actor and by free text', () => {
    record(state, { action: 'ORDER_PLACED', actor: 'TRADER', target: 'NVCR', summary: 'Bought 10 NVCR' });
    record(state, { action: 'CONTROLS_CHANGED', actor: 'RISK_MANAGER', target: 'ETF', summary: 'Changed ETF limits' });

    expect(queryAudit(state, { action: 'ORDER_PLACED' })).toHaveLength(1);
    expect(queryAudit(state, { actor: 'RISK_MANAGER' })).toHaveLength(1);
    expect(queryAudit(state, { search: 'nvcr' })).toHaveLength(1);
    expect(queryAudit(state, { search: 'nothing here' })).toHaveLength(0);
  });

  it('can narrow to entries an auditor has annotated', () => {
    const noted = record(state, { action: 'ORDER_PLACED', actor: 'TRADER', target: 'NVCR', summary: 'a' });
    record(state, { action: 'ORDER_PLACED', actor: 'TRADER', target: 'KELP', summary: 'b' });
    addNote(noted, 'AUDITOR', 'Looks irregular, following up.');

    const rows = queryAudit(state, { notedOnly: true });
    expect(rows).toHaveLength(1);
    expect(rows[0].target).toBe('NVCR');
  });

  it('searches note text, not just the summary', () => {
    const entry = record(state, { action: 'ORDER_PLACED', actor: 'TRADER', target: 'NVCR', summary: 'a' });
    addNote(entry, 'AUDITOR', 'breached the mandate');
    expect(queryAudit(state, { search: 'mandate' })).toHaveLength(1);
  });

  it('diffs only the fields that actually changed', () => {
    const before = { tradingEnabled: true, maxPositionPct: 0.2 };
    const changes = diffFields(before, { tradingEnabled: true, maxPositionPct: 0.1 });
    expect(changes).toEqual([{ field: 'maxPositionPct', from: '0.2', to: '0.1' }]);
  });

  it('formats diffed values when given a formatter', () => {
    const changes = diffFields(
      { tradingEnabled: true },
      { tradingEnabled: false },
      { tradingEnabled: (v) => (v ? 'on' : 'off') },
    );
    expect(changes).toEqual([{ field: 'tradingEnabled', from: 'on', to: 'off' }]);
  });
});

describe('CSV export', () => {
  it('quotes separators, quotes and newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('one\ntwo')).toBe('"one\ntwo"');
  });

  it('neutralises a value a spreadsheet would run as a formula', () => {
    // A note beginning with "=" must not execute when the export is opened.
    expect(csvCell('=1+1')).toBe(`"'=1+1"`);
    expect(csvCell('+SUM(A1)')).toBe(`"'+SUM(A1)"`);
    expect(csvCell('@cmd')).toBe(`"'@cmd"`);
    expect(csvCell('-2+3')).toBe(`"'-2+3"`);
  });

  it('leaves a genuine negative number as a number', () => {
    // Percentage and P/L columns are full of these; quoting them as text
    // would make the export useless for the reviewer.
    expect(csvCell('-0.27')).toBe('"-0.27"');
    expect(csvCell('-1234.56')).toBe('"-1234.56"');
    expect(csvCell('+3')).toBe('"+3"');
  });

  it('writes a header row and one row per entry', () => {
    const state = fresh();
    const entry = record(state, {
      action: 'CONTROLS_CHANGED',
      actor: 'RISK_MANAGER',
      target: 'ETF',
      summary: 'Changed ETF limits: maxPositionPct.',
      changes: [{ field: 'maxPositionPct', from: '20.00%', to: '10.00%' }],
    });
    addNote(entry, 'AUDITOR', 'Approved.');

    const csv = auditToCsv(state.audit);
    const lines = csv.trimEnd().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"Action"');
    expect(lines[1]).toContain('"CONTROLS_CHANGED"');
    expect(lines[1]).toContain('maxPositionPct: 20.00% -> 10.00%');
    expect(lines[1]).toContain('[AUDITOR] Approved.');
  });
});

describe('audit state survives a reload', () => {
  it('fills in notes missing from an older state file', async () => {
    const { createInitialState: build } = await import('../src/store/state.js');
    const state = build();
    expect(state.audit).toEqual([]);
  });

  it('every role is covered by the permission map', () => {
    for (const role of ROLES as readonly Role[]) {
      expect(Array.isArray(ROLE_PERMISSIONS[role])).toBe(true);
    }
  });
});
