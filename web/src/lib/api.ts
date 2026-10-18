import type {
  Alert,
  AssetType,
  AuditAction,
  AuditEntry,
  AuditNote,
  EngineSettings,
  HistoryPoint,
  Identity,
  Instrument,
  Order,
  OrderSide,
  PortfolioSnapshot,
  Role,
  TypeControls,
} from '../../../shared/src/types.js';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when the server refused because of the active role, not the input. */
  get isForbidden(): boolean {
    return this.code === 'FORBIDDEN';
  }
}

/**
 * The role every request travels with. The server is the thing that enforces
 * it; this just says who we are claiming to be. Where a deployment sets
 * STOCKPLAY_ROLE_TOKENS, the matching token has to travel too.
 */
let activeRole: Role = 'TRADER';
let activeToken: string | null = null;

export function setActiveRole(role: Role, token?: string | null): void {
  activeRole = role;
  activeToken = token ?? null;
}

export function getActiveRole(): Role {
  return activeRole;
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'x-stockplay-role': activeRole };
  if (activeToken) headers['x-stockplay-token'] = activeToken;
  return headers;
}

/** The SSE stream cannot carry headers, so the role rides in the query. */
export function streamUrl(): string {
  return `/api/stream?role=${encodeURIComponent(activeRole)}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      headers: {
        ...authHeaders(),
        ...(init?.body ? { 'content-type': 'application/json' } : null),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError('Cannot reach the StockPlay server.', 'OFFLINE');
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { error?: { message?: string; code?: string } }
      | null;
    throw new ApiError(
      body?.error?.message ?? `Request failed (${response.status}).`,
      body?.error?.code ?? 'HTTP_ERROR',
    );
  }
  return (await response.json()) as T;
}

export interface NewInstrument {
  symbol: string;
  name: string;
  type: AssetType;
  exchange: string;
  sector: string;
  price: number;
}

export interface AuditFilters {
  action?: AuditAction | '';
  actor?: Role | '';
  search?: string;
  notedOnly?: boolean;
}

function auditQuery(filters: AuditFilters): string {
  const params = new URLSearchParams();
  if (filters.action) params.set('action', filters.action);
  if (filters.actor) params.set('actor', filters.actor);
  if (filters.search?.trim()) params.set('search', filters.search.trim());
  if (filters.notedOnly) params.set('noted', 'true');
  return params.toString();
}

export const api = {
  me: () => request<Identity>('/me'),
  portfolio: () => request<PortfolioSnapshot>('/portfolio'),
  history: (points = 240) => request<HistoryPoint[]>(`/history?points=${points}`),
  instruments: () => request<Instrument[]>('/instruments'),
  orders: (limit = 25) => request<Order[]>(`/orders?limit=${limit}`),
  controls: () => request<TypeControls[]>('/controls'),
  engine: () => request<EngineSettings>('/engine'),
  alerts: () => request<Alert[]>('/alerts'),

  addInstrument: (body: NewInstrument) =>
    request<Instrument>('/instruments', { method: 'POST', body: JSON.stringify(body) }),
  updateInstrument: (id: string, body: Partial<Instrument>) =>
    request<Instrument>(`/instruments/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  removeInstrument: (id: string) =>
    request<{ removed: string }>(`/instruments/${id}`, { method: 'DELETE' }),

  placeOrder: (body: { instrumentId: string; side: OrderSide; quantity: number }) =>
    request<{ order: Order; portfolio: PortfolioSnapshot }>('/orders', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateControls: (type: AssetType, body: Partial<TypeControls>) =>
    request<TypeControls>(`/controls/${type}`, { method: 'PATCH', body: JSON.stringify(body) }),
  updateEngine: (body: Partial<EngineSettings>) =>
    request<EngineSettings>('/engine', { method: 'PATCH', body: JSON.stringify(body) }),

  ackAlert: (id: string) => request<Alert>(`/alerts/${id}/ack`, { method: 'POST' }),
  ackAllAlerts: () => request<{ cleared: number }>('/alerts/ack-all', { method: 'POST' }),

  audit: (filters: AuditFilters = {}) => {
    const query = auditQuery(filters);
    return request<AuditEntry[]>(`/audit${query ? `?${query}` : ''}`);
  },
  addAuditNote: (id: string, text: string) =>
    request<{ note: AuditNote; entry: AuditEntry }>(`/audit/${id}/notes`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  /** Export URLs are plain links, but the role has to ride along, so the file
   *  is fetched and handed to the browser as a blob rather than navigated to. */
  download: async (path: string, filename: string, filters: AuditFilters = {}) => {
    const query = auditQuery(filters);
    const response = await fetch(`/api${path}${query ? `?${query}` : ''}`, {
      headers: authHeaders(),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as
        | { error?: { message?: string; code?: string } }
        | null;
      throw new ApiError(
        body?.error?.message ?? `Export failed (${response.status}).`,
        body?.error?.code ?? 'HTTP_ERROR',
      );
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  },
};
