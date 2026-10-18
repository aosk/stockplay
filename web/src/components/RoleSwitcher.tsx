import { ROLES, ROLE_PROFILES, type Role } from '../../../shared/src/types.js';
import { useStore } from '../lib/store.js';

/**
 * Picks the role the UI acts as. This is a role selection, not a sign-in —
 * the pill beside it says so plainly unless the deployment pins roles to a
 * token, in which case the server is the one deciding.
 */
export function RoleSwitcher() {
  const { role, setRole, identity } = useStore();

  return (
    <span className="role-switcher">
      <label className="visually-hidden" htmlFor="role-select">
        Acting as
      </label>
      <span className={`role-dot role-dot-${role.toLowerCase()}`} aria-hidden="true" />
      <select
        id="role-select"
        value={role}
        onChange={(event) => setRole(event.target.value as Role)}
        title={ROLE_PROFILES[role].blurb}
      >
        {ROLES.map((option) => (
          <option key={option} value={option}>
            {ROLE_PROFILES[option].label}
          </option>
        ))}
      </select>
      {identity && !identity.tokenEnforced ? (
        <span className="role-note" title="Roles are self-declared in this deployment: the server trusts the role a request names. Set STOCKPLAY_ROLE_TOKENS to make it unforgeable.">
          unverified
        </span>
      ) : null}
    </span>
  );
}
