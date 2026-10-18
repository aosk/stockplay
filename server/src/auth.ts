import type { NextFunction, Request, Response } from 'express';
import {
  ROLES,
  ROLE_PERMISSIONS,
  type Identity,
  type Permission,
  type Role,
} from '../../shared/src/types.js';

export const ROLE_HEADER = 'x-stockplay-role';
export const TOKEN_HEADER = 'x-stockplay-token';
/** The SSE stream cannot carry headers, so it names the role in the query. */
export const ROLE_QUERY = 'role';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      identity: Identity;
    }
  }
}

function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/**
 * Reads the per-role tokens from the environment, as
 * `STOCKPLAY_ROLE_TOKENS='{"AUDITOR":"…","TRADER":"…"}'`.
 *
 * Unset — the default for local use — means a caller simply names its role and
 * the server believes it. That is honest for a single-user tool on localhost,
 * but it is NOT access control: anyone who can reach the port can claim any
 * role. Set the variable for any deployment where the distinction has to hold.
 */
function readRoleTokens(): Partial<Record<Role, string>> | null {
  const raw = process.env.STOCKPLAY_ROLE_TOKENS;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Partial<Record<Role, string>> = {};
    for (const role of ROLES) {
      const token = parsed[role];
      if (typeof token === 'string' && token.length > 0) out[role] = token;
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    console.error('[stockplay] STOCKPLAY_ROLE_TOKENS is not valid JSON; ignoring it.');
    return null;
  }
}

const ROLE_TOKENS = readRoleTokens();
export const TOKEN_ENFORCED = ROLE_TOKENS !== null;

/** The role a request falls back to when it names none. */
export const DEFAULT_ROLE: Role = 'TRADER';

/**
 * When tokens are configured, a request may only hold a role whose token it
 * presents; anything else drops to the least-privileged role rather than being
 * rejected, so the dashboard still renders for a viewer with no token.
 */
export const LEAST_PRIVILEGED_ROLE: Role = 'AUDITOR';

function resolveRole(req: Request): Role {
  const header = req.get(ROLE_HEADER);
  const query = typeof req.query[ROLE_QUERY] === 'string' ? (req.query[ROLE_QUERY] as string) : null;
  const claimed = header ?? query;
  const role = isRole(claimed) ? claimed : DEFAULT_ROLE;

  if (!ROLE_TOKENS) return role;

  const expected = ROLE_TOKENS[role];
  const presented = req.get(TOKEN_HEADER);
  if (expected && presented === expected) return role;
  return LEAST_PRIVILEGED_ROLE;
}

/** Attaches the caller's identity to every request. */
export function identify(req: Request, _res: Response, next: NextFunction): void {
  const role = resolveRole(req);
  req.identity = {
    role,
    permissions: ROLE_PERMISSIONS[role],
    tokenEnforced: TOKEN_ENFORCED,
  };
  next();
}

export interface DeniedEvent {
  role: Role;
  permission: Permission;
  method: string;
  path: string;
}

/**
 * Guards a route. A refusal is recorded as well as returned — an attempt to
 * act beyond a role is exactly the kind of thing an auditor needs to see.
 */
export function requirePermission(
  permission: Permission,
  onDenied?: (event: DeniedEvent) => void,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.identity.permissions.includes(permission)) {
      next();
      return;
    }
    onDenied?.({
      role: req.identity.role,
      permission,
      method: req.method,
      path: req.originalUrl.split('?')[0],
    });
    res.status(403).json({
      error: {
        code: 'FORBIDDEN',
        message: `The ${req.identity.role.replace('_', ' ').toLowerCase()} role cannot do this (needs "${permission}").`,
        role: req.identity.role,
        required: permission,
      },
    });
  };
}
