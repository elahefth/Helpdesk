import { USER_ROLES, type UserRole } from "@helpdesk/shared";

/**
 * The accounts global-setup seeds and auth.setup.ts signs in as.
 *
 * Plain constants rather than environment variables: Playwright's runner is a
 * Node process that never loads .env.test (only the API it spawns does), so
 * reading these from the environment would mean adding a dotenv dependency to
 * carry four strings. Keeping them here means the seed step and the sign-in
 * step import the same values and cannot drift.
 *
 * Passwords clear Better Auth's eight-character floor.
 */
export interface E2EUser {
  email: string;
  password: string;
  name: string;
  role: UserRole;
}

export const E2E_USERS = {
  admin: {
    email: "admin@e2e.test",
    password: "e2e-admin-password",
    name: "E2E Admin",
    role: "admin",
  },
  agent: {
    email: "agent@e2e.test",
    password: "e2e-agent-password",
    name: "E2E Agent",
    role: "agent",
  },
} as const satisfies Record<UserRole, E2EUser>;

export type E2ERole = keyof typeof E2E_USERS;

/** Kept in role order so the seeded set stays in step with @helpdesk/shared. */
export const E2E_ROLES: readonly E2ERole[] = USER_ROLES;
