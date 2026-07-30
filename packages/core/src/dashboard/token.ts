import { randomBytes } from 'node:crypto';

/**
 * Generates a fresh, unguessable access token for one dashboard server
 * run (audit defect D-17: "unauthenticated dashboard"). Never persisted —
 * a new token every time `tokenlens dashboard` starts, printed once in
 * the launch URL.
 */
export function generateDashboardToken(): string {
  return randomBytes(24).toString('base64url');
}
