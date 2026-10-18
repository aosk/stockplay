import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AUDIT_ACTIONS,
  ROLES,
  ROLE_PERMISSIONS,
  ROLE_PROFILES,
  PERMISSIONS,
  type AuditAction,
  type AuditEntry,
  type Role,
} from '../../../shared/src/types.js';
import { Banner, Card } from '../components/ui.js';
import { api, ApiError, type AuditFilters } from '../lib/api.js';
import { useStore } from '../lib/store.js';

const ACTION_LABEL: Record<AuditAction, string> = {
  ORDER_PLACED: 'Order placed',
  CONTROLS_CHANGED: 'Limits changed',
  ENGINE_CHANGED: 'Simulation changed',
  INSTRUMENT_ADDED: 'Stock added',
  INSTRUMENT_CHANGED: 'Stock changed',
  INSTRUMENT_REMOVED: 'Stock removed',
  ALERT_ACKNOWLEDGED: 'Alert acknowledged',
  ACCESS_DENIED: 'Access refused',
};

const ACTION_CLASS: Record<AuditAction, string> = {
  ORDER_PLACED: 'action-order',
  CONTROLS_CHANGED: 'action-controls',
  ENGINE_CHANGED: 'action-engine',
  INSTRUMENT_ADDED: 'action-instrument',
  INSTRUMENT_CHANGED: 'action-instrument',
  INSTRUMENT_REMOVED: 'action-instrument',
  ALERT_ACKNOWLEDGED: 'action-alert',
  ACCESS_DENIED: 'action-denied',
};

function when(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function AuditPage() {
  const { allows, role, identity, audit, setAudit, ready, loadError } = useStore();
  const [filters, setFilters] = useState<AuditFilters>({ action: '', actor: '', search: '', notedOnly: false });
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const canRead = allows('audit:read');
  const canNote = allows('audit:note');
  const canExport = allows('export');

  const reload = useCallback(
    async (next: AuditFilters) => {
      if (!canRead) return;
      setBusy(true);
      try {
        setAudit(await api.audit(next));
        setNotice(null);
      } catch (err) {
        setNotice({ tone: 'error', text: err instanceof ApiError ? err.message : 'Could not read the trail.' });
      } finally {
        setBusy(false);
      }
    },
    [canRead, setAudit],
  );

  // Re-query on the server rather than filtering in the browser: the trail can
  // be far longer than the page ever holds.
  useEffect(() => {
    const timer = window.setTimeout(() => void reload(filters), 250);
    return () => window.clearTimeout(timer);
  }, [filters, reload]);

  const counts = useMemo(() => {
    const byAction = new Map<AuditAction, number>();
    let noted = 0;
    let denied = 0;
    for (const entry of audit) {
      byAction.set(entry.action, (byAction.get(entry.action) ?? 0) + 1);
      if (entry.notes.length) noted += 1;
      if (entry.action === 'ACCESS_DENIED') denied += 1;
    }
    return { byAction, noted, denied };
  }, [audit]);

  if (loadError && !ready) {
    return (
      <Banner tone="error">
        {loadError} Start the API with <code>npm run dev:server</code> and reload.
      </Banner>
    );
  }

  if (!canRead) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1>Audit trail</h1>
            <p>Every change to the book, the limits and the simulation, with who made it.</p>
          </div>
        </div>
        <Card title="Not available to this role" subtitle={`You are acting as ${ROLE_PROFILES[role].label.toLowerCase()}.`}>
          <p className="card-sub" style={{ marginTop: 10 }}>
            The trail is readable by the auditor and the risk manager. Switch role in the header to
            read it. The server enforces this: a request from a role without{' '}
            <code>audit:read</code> is refused with a 403 and the refusal is itself recorded.
          </p>
          <RoleMatrix />
        </Card>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Audit trail</h1>
          <p>
            Every change to the book, the limits and the simulation — and every attempt that was
            refused — with who made it and what it changed.
          </p>
        </div>
        {canExport ? (
          <div className="card-actions">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() =>
                api
                  .download('/export/audit.csv', 'stockplay-audit.csv', filters)
                  .catch((err: unknown) =>
                    setNotice({
                      tone: 'error',
                      text: err instanceof ApiError ? err.message : 'Export failed.',
                    }),
                  )
              }
            >
              Export trail (CSV)
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() =>
                api
                  .download('/export/holdings.csv', 'stockplay-holdings.csv')
                  .catch(() => setNotice({ tone: 'error', text: 'Export failed.' }))
              }
            >
              Holdings
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() =>
                api
                  .download('/export/orders.csv', 'stockplay-orders.csv')
                  .catch(() => setNotice({ tone: 'error', text: 'Export failed.' }))
              }
            >
              Orders
            </button>
          </div>
        ) : null}
      </div>

      {notice ? (
        <Banner tone={notice.tone} onDismiss={() => setNotice(null)}>
          {notice.text}
        </Banner>
      ) : null}

      <div className="filter-row">
        <span className="filter-label" id="audit-action-label">
          Action
        </span>
        <select
          aria-labelledby="audit-action-label"
          style={{ width: 'auto' }}
          value={filters.action}
          onChange={(e) => setFilters({ ...filters, action: e.target.value as AuditAction | '' })}
        >
          <option value="">All actions</option>
          {AUDIT_ACTIONS.map((action) => (
            <option key={action} value={action}>
              {ACTION_LABEL[action]}
            </option>
          ))}
        </select>

        <span className="filter-sep" aria-hidden="true" />
        <span className="filter-label" id="audit-actor-label">
          Actor
        </span>
        <select
          aria-labelledby="audit-actor-label"
          style={{ width: 'auto' }}
          value={filters.actor}
          onChange={(e) => setFilters({ ...filters, actor: e.target.value as Role | '' })}
        >
          <option value="">Any role</option>
          {ROLES.map((option) => (
            <option key={option} value={option}>
              {ROLE_PROFILES[option].label}
            </option>
          ))}
        </select>

        <span className="filter-sep" aria-hidden="true" />
        <label className="visually-hidden" htmlFor="audit-search">
          Search the trail
        </label>
        <input
          id="audit-search"
          type="text"
          placeholder="Search symbol, summary or note…"
          style={{ width: 'min(300px, 40vw)', minWidth: 190 }}
          value={filters.search}
          onChange={(e) => setFilters({ ...filters, search: e.target.value })}
        />

        <button
          type="button"
          className="chip"
          aria-pressed={!!filters.notedOnly}
          onClick={() => setFilters({ ...filters, notedOnly: !filters.notedOnly })}
        >
          Reviewed only
          <span className="chip-check" aria-hidden="true">
            {filters.notedOnly ? '✓' : ''}
          </span>
        </button>

        <div style={{ marginLeft: 'auto' }} className="card-sub">
          {busy ? 'Reading…' : `${audit.length} entries · ${counts.noted} reviewed · ${counts.denied} refused`}
        </div>
      </div>

      <div className="grid grid-main">
        <Card
          title="Trail"
          subtitle={
            canNote
              ? 'Newest first. Leave a review note on any entry.'
              : 'Newest first. Only the auditor role can leave review notes.'
          }
        >
          {audit.length === 0 ? (
            <div className="empty">Nothing matches these filters yet.</div>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col" className="col-left">When</th>
                    <th scope="col" className="col-left">Actor</th>
                    <th scope="col" className="col-left">Action</th>
                    <th scope="col" className="col-left">What happened</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.map((entry) => (
                    <AuditRow key={entry.id} entry={entry} canNote={canNote} onNoted={() => void reload(filters)} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div className="grid" style={{ gap: 16 }}>
          <Card title="Your access" subtitle={ROLE_PROFILES[role].blurb}>
            <RoleMatrix />
            {identity && !identity.tokenEnforced ? (
              <p className="card-sub" style={{ marginTop: 12 }}>
                Roles are <strong>self-declared</strong> in this deployment — the server honours the
                role a request names. Set <code>STOCKPLAY_ROLE_TOKENS</code> to require a token per
                role and make the distinction hold.
              </p>
            ) : (
              <p className="card-sub" style={{ marginTop: 12 }}>
                Roles are token-verified in this deployment. A request without the right token drops
                to the auditor role.
              </p>
            )}
          </Card>

          <Card title="By action" subtitle="Across the entries currently listed">
            {audit.length === 0 ? (
              <div className="empty">Nothing to summarise.</div>
            ) : (
              <dl className="kv-list">
                {AUDIT_ACTIONS.filter((action) => counts.byAction.get(action)).map((action) => (
                  <div className="kv" key={action}>
                    <dt>
                      <span className={`action-tag ${ACTION_CLASS[action]}`}>{ACTION_LABEL[action]}</span>
                    </dt>
                    <dd>{counts.byAction.get(action)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

function RoleMatrix() {
  const { role } = useStore();
  const held = ROLE_PERMISSIONS[role];
  return (
    <div className="perm-list">
      {PERMISSIONS.map((permission) => (
        <span
          key={permission}
          className={`perm ${held.includes(permission) ? 'perm-on' : 'perm-off'}`}
          title={held.includes(permission) ? 'Allowed' : 'Refused by the server'}
        >
          {permission}
        </span>
      ))}
    </div>
  );
}

function AuditRow({
  entry,
  canNote,
  onNoted,
}: {
  entry: AuditEntry;
  canNote: boolean;
  onNoted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    try {
      await api.addAuditNote(entry.id, text.trim());
      setText('');
      setOpen(false);
      setError(null);
      onNoted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the note.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr>
      <td className="audit-when">{when(entry.at)}</td>
      <td style={{ textAlign: 'left' }}>
        <span className="type-badge">
          <span className={`role-dot role-dot-${entry.actor.toLowerCase()}`} aria-hidden="true" />
          {ROLE_PROFILES[entry.actor].label}
        </span>
      </td>
      <td style={{ textAlign: 'left' }}>
        <span className={`action-tag ${ACTION_CLASS[entry.action]}`}>{ACTION_LABEL[entry.action]}</span>
      </td>
      <td className="audit-cell">
        <div>
          <strong>{entry.target}</strong> — {entry.summary}
        </div>

        {entry.changes?.length ? (
          <ul className="audit-changes">
            {entry.changes.map((change) => (
              <li key={change.field}>
                <span className="audit-field">{change.field}</span>
                <span className="audit-from">{change.from}</span>
                <span className="audit-arrow" aria-hidden="true">
                  →
                </span>
                <span className="audit-to">{change.to}</span>
              </li>
            ))}
          </ul>
        ) : null}

        {entry.notes.length ? (
          <ul className="audit-notes">
            {entry.notes.map((note) => (
              <li className="audit-note" key={note.id}>
                {note.text}
                <div className="audit-note-meta">
                  {ROLE_PROFILES[note.author].label} · {when(note.createdAt)}
                </div>
              </li>
            ))}
          </ul>
        ) : null}

        {canNote ? (
          open ? (
            <form className="note-form" onSubmit={submit}>
              <label className="visually-hidden" htmlFor={`note-${entry.id}`}>
                Review note for {entry.summary}
              </label>
              <textarea
                id={`note-${entry.id}`}
                value={text}
                maxLength={1000}
                placeholder="Reviewed — approved / query raised…"
                onChange={(e) => setText(e.target.value)}
                autoFocus
              />
              <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !text.trim()}>
                Save
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>
                Cancel
              </button>
            </form>
          ) : (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              style={{ marginTop: 8 }}
              onClick={() => setOpen(true)}
            >
              {entry.notes.length ? '+ Add another note' : '+ Add review note'}
            </button>
          )
        ) : null}

        {error ? (
          <p className="field-hint" style={{ color: 'var(--status-critical)' }}>
            {error}
          </p>
        ) : null}
      </td>
    </tr>
  );
}
