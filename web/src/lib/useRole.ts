import { useCallback, useEffect, useState } from 'react';
import {
  ROLES,
  ROLE_PERMISSIONS,
  type Permission,
  type Role,
} from '../../../shared/src/types.js';
import { setActiveRole } from './api.js';

const ROLE_KEY = 'stockplay:role';
const TOKEN_KEY = 'stockplay:token';

function readSavedRole(): Role {
  try {
    const saved = localStorage.getItem(ROLE_KEY);
    if (saved && (ROLES as readonly string[]).includes(saved)) return saved as Role;
  } catch {
    /* blocked storage — fall through to the default */
  }
  return 'TRADER';
}

function readSavedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

// The API module has to know the role before the first request goes out, so
// seed it at import time rather than waiting for the first render.
setActiveRole(readSavedRole(), readSavedToken());

/**
 * The role the UI is acting as. Switching it re-reads everything, because what
 * the server returns — and refuses — depends on it.
 *
 * This is a role *selection*, not a login. The server enforces the role it is
 * told, and only a deployment that sets STOCKPLAY_ROLE_TOKENS makes the claim
 * unforgeable. The UI says as much where it matters.
 */
export function useRole() {
  const [role, setRoleState] = useState<Role>(readSavedRole);
  const [token, setTokenState] = useState<string | null>(readSavedToken);

  useEffect(() => {
    setActiveRole(role, token);
    try {
      localStorage.setItem(ROLE_KEY, role);
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* not remembering the choice is survivable */
    }
  }, [role, token]);

  const setRole = useCallback((next: Role) => setRoleState(next), []);
  const setToken = useCallback((next: string | null) => setTokenState(next), []);

  const allows = useCallback(
    (permission: Permission) => ROLE_PERMISSIONS[role].includes(permission),
    [role],
  );

  return { role, setRole, token, setToken, allows };
}
