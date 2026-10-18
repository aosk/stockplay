import { Router, type Request, type Response } from 'express';
import {
  ASSET_TYPES,
  ASSET_TYPE_PROFILES,
  AUDIT_ACTIONS,
  ROLES,
  ROLE_PROFILES,
  type AssetType,
  type AuditAction,
  type Instrument,
  type Role,
} from '../../../shared/src/types.js';
import { TOKEN_ENFORCED, requirePermission, type DeniedEvent } from '../auth.js';
import type { EventBus } from '../bus.js';
import { evaluateAlerts } from '../engine/alerts.js';
import {
  addNote,
  auditToCsv,
  diffFields,
  queryAudit,
  record,
  rowsToCsv,
} from '../engine/audit.js';
import { snapshot } from '../engine/portfolio.js';
import { TradeError, placeOrder } from '../engine/trading.js';
import type { AppState } from '../store/state.js';

export interface ApiContext {
  state: AppState;
  bus: EventBus;
  /** Persists state; debounced by the caller. */
  persist: () => void;
  /** Re-reads engine settings after the control page changes them. */
  onEngineChange: () => void;
}

function bad(res: Response, message: string, code = 'BAD_REQUEST', status = 400): void {
  res.status(status).json({ error: { code, message } });
}

function isAssetType(value: unknown): value is AssetType {
  return typeof value === 'string' && (ASSET_TYPES as readonly string[]).includes(value);
}

function num(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function slug(symbol: string): string {
  return `ins_${symbol.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
}

function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

function isAuditAction(value: unknown): value is AuditAction {
  return typeof value === 'string' && (AUDIT_ACTIONS as readonly string[]).includes(value);
}

const pct = (value: unknown): string => `${(Number(value) * 100).toFixed(2)}%`;
const times = (value: unknown): string => `${Number(value).toFixed(2)}x`;
const onOff = (value: unknown): string => (value ? 'on' : 'off');

function sendCsv(res: Response, filename: string, body: string): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // A BOM so Excel opens the file as UTF-8 rather than guessing.
  res.send(`\uFEFF${body}`);
}

export function createApiRouter(ctx: ApiContext): Router {
  const router = Router();
  const { state, bus } = ctx;

  /** A refusal is itself auditable: the auditor should see what was attempted. */
  const onDenied = (event: DeniedEvent) => {
    record(state, {
      action: 'ACCESS_DENIED',
      actor: event.role,
      target: `${event.method} ${event.path}`,
      summary: `Refused: the ${ROLE_PROFILES[event.role].label.toLowerCase()} role lacks "${event.permission}".`,
    });
    ctx.persist();
  };

  const need = (permission: Parameters<typeof requirePermission>[0]) =>
    requirePermission(permission, onDenied);

  // ---- who am I -----------------------------------------------------------

  router.get('/me', (req, res) => {
    res.json(req.identity);
  });

  // ---- reference data -----------------------------------------------------

  router.get('/meta', (_req, res) => {
    res.json({
      assetTypes: ASSET_TYPES.map((type) => ({ type, ...ASSET_TYPE_PROFILES[type] })),
      roles: ROLES.map((role) => ({ role, ...ROLE_PROFILES[role] })),
      auditActions: AUDIT_ACTIONS,
      tokenEnforced: TOKEN_ENFORCED,
    });
  });

  // ---- dashboard ----------------------------------------------------------

  router.get('/portfolio', (_req, res) => {
    res.json(snapshot(state));
  });

  router.get('/history', (req, res) => {
    const points = num(req.query.points) ?? 240;
    const limit = clamp(Math.floor(points), 10, state.history.length || 10);
    res.json(state.history.slice(-limit));
  });

  router.get('/instruments', (_req, res) => {
    res.json(state.instruments);
  });

  router.get('/orders', (req, res) => {
    const limit = clamp(Math.floor(num(req.query.limit) ?? 50), 1, 200);
    res.json(state.orders.slice(0, limit));
  });

  // ---- control page: the book ---------------------------------------------

  router.post('/instruments', need('instruments:manage'), (req, res) => {
    const body = req.body ?? {};
    const symbol = String(body.symbol ?? '').trim().toUpperCase();
    const name = String(body.name ?? '').trim();
    const price = num(body.price);

    if (!/^[A-Z0-9.\-]{1,12}$/.test(symbol)) {
      return bad(res, 'Symbol must be 1–12 characters: letters, digits, dot or dash.');
    }
    if (!name) return bad(res, 'Name is required.');
    if (!isAssetType(body.type)) {
      return bad(res, `Type must be one of: ${ASSET_TYPES.join(', ')}.`);
    }
    if (price === null || price <= 0) return bad(res, 'Price must be greater than zero.');
    if (state.instruments.some((i) => i.symbol === symbol)) {
      return bad(res, `${symbol} is already in the book.`, 'DUPLICATE', 409);
    }

    const now = new Date(state.simTime).toISOString();
    const instrument: Instrument = {
      id: slug(symbol),
      symbol,
      name,
      type: body.type,
      exchange: String(body.exchange ?? 'NYSE').trim() || 'NYSE',
      sector: String(body.sector ?? 'Unclassified').trim() || 'Unclassified',
      currency: String(body.currency ?? 'USD').trim().toUpperCase() || 'USD',
      price,
      previousClose: price,
      basePrice: price,
      active: true,
      createdAt: now,
      updatedAt: now,
    };

    state.instruments.push(instrument);
    state.navClocks[instrument.id] = 0;
    record(state, {
      action: 'INSTRUMENT_ADDED',
      actor: req.identity.role,
      target: instrument.symbol,
      summary: `Added ${instrument.symbol} (${instrument.name}) as ${ASSET_TYPE_PROFILES[instrument.type].label} at ${instrument.price.toFixed(2)}.`,
    });
    ctx.persist();
    bus.emit({ kind: 'book', payload: { instruments: state.instruments } });
    res.status(201).json(instrument);
  });

  router.patch('/instruments/:id', need('instruments:manage'), (req, res) => {
    const instrument = state.instruments.find((i) => i.id === req.params.id);
    if (!instrument) return bad(res, 'Unknown instrument.', 'NOT_FOUND', 404);

    const before = { ...instrument };
    const body = req.body ?? {};
    if (body.name !== undefined) instrument.name = String(body.name).trim() || instrument.name;
    if (body.sector !== undefined) instrument.sector = String(body.sector).trim() || instrument.sector;
    if (body.exchange !== undefined) instrument.exchange = String(body.exchange).trim() || instrument.exchange;
    if (body.type !== undefined) {
      if (!isAssetType(body.type)) return bad(res, 'Unknown asset type.');
      instrument.type = body.type;
    }
    if (body.active !== undefined) instrument.active = Boolean(body.active);
    if (body.price !== undefined) {
      const price = num(body.price);
      if (price === null || price <= 0) return bad(res, 'Price must be greater than zero.');
      instrument.price = price;
    }
    instrument.updatedAt = new Date(state.simTime).toISOString();

    const changes = diffFields(
      before as unknown as Record<string, unknown>,
      {
        name: instrument.name,
        type: instrument.type,
        sector: instrument.sector,
        exchange: instrument.exchange,
        active: instrument.active,
        price: instrument.price,
      },
      { active: onOff },
    );
    if (changes?.length) {
      record(state, {
        action: 'INSTRUMENT_CHANGED',
        actor: req.identity.role,
        target: instrument.symbol,
        summary: `Updated ${instrument.symbol}: ${changes.map((c) => c.field).join(', ')}.`,
        changes,
      });
    }

    ctx.persist();
    bus.emit({ kind: 'book', payload: { instruments: state.instruments } });
    res.json(instrument);
  });

  router.delete('/instruments/:id', need('instruments:manage'), (req, res) => {
    const index = state.instruments.findIndex((i) => i.id === req.params.id);
    if (index === -1) return bad(res, 'Unknown instrument.', 'NOT_FOUND', 404);

    const held = state.positions.find((p) => p.instrumentId === req.params.id);
    if (held && held.quantity > 0) {
      return bad(
        res,
        `${state.instruments[index].symbol} still holds ${held.quantity} shares. Sell the position before removing it.`,
        'POSITION_OPEN',
        409,
      );
    }

    const [removed] = state.instruments.splice(index, 1);
    state.positions = state.positions.filter((p) => p.instrumentId !== removed.id);
    delete state.navClocks[removed.id];
    record(state, {
      action: 'INSTRUMENT_REMOVED',
      actor: req.identity.role,
      target: removed.symbol,
      summary: `Removed ${removed.symbol} (${removed.name}) from the book.`,
    });
    ctx.persist();
    bus.emit({ kind: 'book', payload: { instruments: state.instruments } });
    res.json({ removed: removed.id });
  });

  // ---- control page: trading ----------------------------------------------

  router.post('/orders', need('trade'), (req, res) => {
    const body = req.body ?? {};
    const side = String(body.side ?? '').toUpperCase();
    if (side !== 'BUY' && side !== 'SELL') return bad(res, 'Side must be BUY or SELL.');

    try {
      const order = placeOrder(state, {
        instrumentId: String(body.instrumentId ?? ''),
        side,
        quantity: Number(body.quantity),
      });
      const snap = snapshot(state);
      record(state, {
        action: 'ORDER_PLACED',
        actor: req.identity.role,
        target: order.symbol,
        summary: `${order.side === 'BUY' ? 'Bought' : 'Sold'} ${order.quantity} ${order.symbol} at ${order.price.toFixed(2)} (${order.notional.toFixed(2)}).`,
      });
      ctx.persist();
      bus.emit({ kind: 'tick', payload: { portfolio: snap } });
      res.status(201).json({ order, portfolio: snap });
    } catch (err) {
      if (err instanceof TradeError) return bad(res, err.message, err.code, 422);
      throw err;
    }
  });

  // ---- control page: per-type controls ------------------------------------

  router.get('/controls', (_req, res) => {
    res.json(ASSET_TYPES.map((type) => state.controls[type]));
  });

  router.patch('/controls/:type', need('controls:manage'), (req, res) => {
    const type = req.params.type as AssetType;
    if (!isAssetType(type)) return bad(res, 'Unknown asset type.', 'NOT_FOUND', 404);

    const controls = state.controls[type];
    const before = { ...controls };
    const body = req.body ?? {};

    if (body.tradingEnabled !== undefined) controls.tradingEnabled = Boolean(body.tradingEnabled);
    for (const field of ['targetAllocation', 'maxPositionPct', 'moveAlertPct', 'stopLossPct'] as const) {
      if (body[field] === undefined) continue;
      const value = num(body[field]);
      if (value === null) return bad(res, `${field} must be a number between 0 and 1.`);
      controls[field] = clamp(value, 0, 1);
    }
    if (body.volatilityFactor !== undefined) {
      const value = num(body.volatilityFactor);
      if (value === null) return bad(res, 'volatilityFactor must be a number between 0.1 and 3.');
      controls.volatilityFactor = clamp(value, 0.1, 3);
    }

    const changes = diffFields(
      before as unknown as Record<string, unknown>,
      { ...controls } as unknown as Record<string, unknown>,
      {
        tradingEnabled: onOff,
        targetAllocation: pct,
        maxPositionPct: pct,
        moveAlertPct: pct,
        stopLossPct: pct,
        volatilityFactor: times,
      },
    );
    if (changes?.length) {
      record(state, {
        action: 'CONTROLS_CHANGED',
        actor: req.identity.role,
        target: ASSET_TYPE_PROFILES[type].label,
        summary: `Changed ${ASSET_TYPE_PROFILES[type].label} limits: ${changes.map((c) => c.field).join(', ')}.`,
        changes,
      });
    }

    ctx.persist();
    bus.emit({ kind: 'settings', payload: { controls: ASSET_TYPES.map((t) => state.controls[t]) } });
    res.json(controls);
  });

  // ---- control page: the simulation ---------------------------------------

  router.get('/engine', (_req, res) => {
    res.json(state.engine);
  });

  router.patch('/engine', need('engine:manage'), (req, res) => {
    const before = { ...state.engine };
    const body = req.body ?? {};
    if (body.running !== undefined) state.engine.running = Boolean(body.running);
    if (body.minutesPerTick !== undefined) {
      const value = num(body.minutesPerTick);
      if (value === null) return bad(res, 'minutesPerTick must be a number.');
      state.engine.minutesPerTick = clamp(Math.round(value), 1, 390);
    }
    if (body.tickIntervalMs !== undefined) {
      const value = num(body.tickIntervalMs);
      if (value === null) return bad(res, 'tickIntervalMs must be a number.');
      state.engine.tickIntervalMs = clamp(Math.round(value), 250, 30_000);
    }
    if (body.marketVolatility !== undefined) {
      const value = num(body.marketVolatility);
      if (value === null) return bad(res, 'marketVolatility must be a number.');
      state.engine.marketVolatility = clamp(value, 0, 4);
    }
    if (body.marketSentiment !== undefined) {
      const value = num(body.marketSentiment);
      if (value === null) return bad(res, 'marketSentiment must be a number.');
      state.engine.marketSentiment = clamp(value, -1, 1);
    }

    const changes = diffFields(
      before as unknown as Record<string, unknown>,
      { ...state.engine } as unknown as Record<string, unknown>,
      { running: (v) => (v ? 'running' : 'paused'), marketVolatility: times },
    );
    if (changes?.length) {
      record(state, {
        action: 'ENGINE_CHANGED',
        actor: req.identity.role,
        target: 'Market simulation',
        summary: `Changed the simulation: ${changes.map((c) => c.field).join(', ')}.`,
        changes,
      });
    }

    ctx.onEngineChange();
    ctx.persist();
    bus.emit({ kind: 'settings', payload: { engine: state.engine } });
    res.json(state.engine);
  });

  // ---- alerts -------------------------------------------------------------

  router.get('/alerts', (req, res) => {
    const openOnly = req.query.open === 'true';
    const rows = openOnly ? state.alerts.filter((a) => !a.acknowledged) : state.alerts;
    res.json(rows.slice(0, 100));
  });

  router.post('/alerts/:id/ack', need('alerts:ack'), (req, res) => {
    const alert = state.alerts.find((a) => a.id === req.params.id);
    if (!alert) return bad(res, 'Unknown alert.', 'NOT_FOUND', 404);
    if (!alert.acknowledged) {
      alert.acknowledged = true;
      record(state, {
        action: 'ALERT_ACKNOWLEDGED',
        actor: req.identity.role,
        target: alert.symbol ?? ASSET_TYPE_PROFILES[alert.type].label,
        summary: `Acknowledged: ${alert.message}`,
      });
    }
    ctx.persist();
    res.json(alert);
  });

  router.post('/alerts/ack-all', need('alerts:ack'), (req, res) => {
    const open = state.alerts.filter((alert) => !alert.acknowledged);
    for (const alert of open) alert.acknowledged = true;
    if (open.length) {
      record(state, {
        action: 'ALERT_ACKNOWLEDGED',
        actor: req.identity.role,
        target: 'All open alerts',
        summary: `Acknowledged ${open.length} open alert${open.length === 1 ? '' : 's'} in one action.`,
      });
    }
    ctx.persist();
    res.json({ cleared: open.length });
  });

  // ---- re-evaluate on demand ----------------------------------------------

  router.post('/alerts/evaluate', (_req, res) => {
    const raised = evaluateAlerts(state, snapshot(state));
    ctx.persist();
    if (raised.length) bus.emit({ kind: 'alerts', payload: { raised } });
    res.json({ raised });
  });

  // ---- audit trail --------------------------------------------------------

  router.get('/audit', need('audit:read'), (req, res) => {
    const action = req.query.action;
    const actor = req.query.actor;
    if (action !== undefined && !isAuditAction(action)) return bad(res, 'Unknown audit action.');
    if (actor !== undefined && !isRole(actor)) return bad(res, 'Unknown role.');

    res.json(
      queryAudit(state, {
        action: action as AuditAction | undefined,
        actor: actor as Role | undefined,
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
        notedOnly: req.query.noted === 'true',
        limit: clamp(Math.floor(num(req.query.limit) ?? 200), 1, 1000),
      }),
    );
  });

  router.post('/audit/:id/notes', need('audit:note'), (req, res) => {
    const entry = state.audit.find((row) => row.id === req.params.id);
    if (!entry) return bad(res, 'Unknown audit entry.', 'NOT_FOUND', 404);

    const text = String((req.body ?? {}).text ?? '').trim();
    if (!text) return bad(res, 'A review note cannot be empty.');
    if (text.length > 1000) return bad(res, 'A review note is limited to 1000 characters.');

    const note = addNote(entry, req.identity.role, text);
    ctx.persist();
    res.status(201).json({ note, entry });
  });

  // ---- CSV exports --------------------------------------------------------

  router.get('/export/audit.csv', need('export'), need('audit:read'), (req, res) => {
    const rows = queryAudit(state, {
      action: isAuditAction(req.query.action) ? req.query.action : undefined,
      actor: isRole(req.query.actor) ? req.query.actor : undefined,
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      notedOnly: req.query.noted === 'true',
      limit: 1000,
    });
    sendCsv(res, 'stockplay-audit.csv', auditToCsv(rows));
  });

  router.get('/export/holdings.csv', need('export'), (_req, res) => {
    const snap = snapshot(state);
    sendCsv(
      res,
      'stockplay-holdings.csv',
      rowsToCsv(
        ['Symbol', 'Name', 'Type', 'Sector', 'Quantity', 'Price', 'Average cost', 'Market value', 'Unrealized P/L', 'Return %', 'Day %', 'Weight %'],
        snap.holdings.map((h) => [
          h.symbol,
          h.name,
          ASSET_TYPE_PROFILES[h.type].label,
          h.sector,
          h.quantity,
          h.price.toFixed(2),
          h.averageCost.toFixed(2),
          h.marketValue.toFixed(2),
          h.unrealizedPnL.toFixed(2),
          (h.unrealizedPnLPct * 100).toFixed(2),
          (h.dayChangePct * 100).toFixed(2),
          (h.weight * 100).toFixed(2),
        ]),
      ),
    );
  });

  router.get('/export/orders.csv', need('export'), (_req, res) => {
    sendCsv(
      res,
      'stockplay-orders.csv',
      rowsToCsv(
        ['Time', 'Symbol', 'Type', 'Side', 'Quantity', 'Price', 'Value'],
        state.orders.map((o) => [
          o.createdAt,
          o.symbol,
          ASSET_TYPE_PROFILES[o.type].label,
          o.side,
          o.quantity,
          o.price.toFixed(2),
          o.notional.toFixed(2),
        ]),
      ),
    );
  });

  // ---- live stream --------------------------------------------------------

  router.get('/stream', (req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 3000\n\n`);
    res.write(
      `event: tick\ndata: ${JSON.stringify({
        portfolio: snapshot(state),
        instruments: state.instruments,
        engine: state.engine,
      })}\n\n`,
    );
    bus.add(res);
    req.on('close', () => res.end());
  });

  return router;
}
