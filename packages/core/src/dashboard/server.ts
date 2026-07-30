import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import type Database from 'better-sqlite3';
import { registerApiRoutes } from './routes.js';
import { resolveDashboardStaticRoot } from './static-root.js';

export interface DashboardServerOptions {
  readonly db: Database.Database;
  readonly token: string;
}

function extractSuppliedToken(request: FastifyRequest): string | undefined {
  const authHeader = request.headers.authorization;
  if (typeof authHeader === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(authHeader);
    if (match?.[1]) return match[1];
  }

  const query = request.query;
  if (query && typeof query === 'object' && 'token' in query) {
    const value = (query as Record<string, unknown>).token;
    if (typeof value === 'string') return value;
  }

  return undefined;
}

/** Constant-time comparison — a naive `===` would leak the token one byte at a time via timing. */
function tokensMatch(supplied: string | undefined, expected: string): boolean {
  if (!supplied) return false;
  const suppliedBuffer = Buffer.from(supplied, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (suppliedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(suppliedBuffer, expectedBuffer);
}

function pathnameOf(url: string): string {
  return url.split('?')[0] ?? url;
}

/**
 * Builds (but does not start listening on) the dashboard's Fastify app.
 *
 * Auth model (audit defect D-17 — "unauthenticated dashboard"): the root
 * page (`/`) and every `/api/*` route require the launch token, checked
 * in constant time, via either `?token=` (how the printed launch URL
 * authenticates the first page load) or an `Authorization: Bearer`
 * header (how the page's own JS authenticates every subsequent fetch,
 * read from its own URL once — see `static/app.js`). Plain static assets
 * (CSS/JS) are exempt: they carry no data, and the browser has no way to
 * attach a header or query string to an automatic `<script src>`/`<link>`
 * fetch, so gating them would just break the page without protecting
 * anything.
 *
 * Binding to `127.0.0.1` specifically (never `0.0.0.0`) is the caller's
 * responsibility at `.listen()` time — see `cli/commands/dashboard.ts`.
 */
export function createDashboardServer(options: DashboardServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });

  app.addHook('onRequest', async (request, reply) => {
    const pathname = pathnameOf(request.url);
    const isProtected = pathname === '/' || pathname.startsWith('/api/');
    if (!isProtected) return;

    if (!tokensMatch(extractSuppliedToken(request), options.token)) {
      await reply.code(401).send({ error: 'unauthorized' });
    }
  });

  registerApiRoutes(app, options.db);

  app.register(fastifyStatic, {
    root: resolveDashboardStaticRoot(),
  });

  return app;
}
