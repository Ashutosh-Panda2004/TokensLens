import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { buildLedger } from '../ledger/ledger.js';
import { forecastBudget, type CopilotPlan } from '../ledger/budget.js';
import { getRequestById } from '../store/database.js';
import { toBudgetView, toLedgerView } from './view-model.js';

interface BudgetQuery {
  readonly plan?: string;
}

interface VerifyParams {
  readonly requestId: string;
}

function parsePlan(value: string | undefined): CopilotPlan {
  return value === 'business' ? 'business' : 'enterprise';
}

/**
 * Registers the JSON API the dashboard's frontend (and `--json`/`--html`
 * exporters — see `export.ts`) consume. Every route is read-only and
 * built entirely on Phase D1 primitives (`buildLedger`, `forecastBudget`,
 * `getRequestById`) — this layer's only job is presentation shaping
 * (`view-model.ts`'s provenance annotation), never new computation.
 */
export function registerApiRoutes(app: FastifyInstance, db: Database.Database): void {
  // Every handler is synchronous — the whole data path is a synchronous
  // better-sqlite3 read, so there is nothing to await, and marking these
  // `async` would only wrap an already-resolved value in a promise.
  app.get('/api/health', (_request, reply: FastifyReply) => {
    reply.send({ status: 'ok' });
  });

  app.get('/api/ledger', (_request, reply: FastifyReply) => {
    reply.send(toLedgerView(buildLedger(db)));
  });

  app.get(
    '/api/budget',
    (request: FastifyRequest<{ Querystring: BudgetQuery }>, reply: FastifyReply) => {
      const summary = buildLedger(db);
      const forecast = forecastBudget(summary, parsePlan(request.query.plan));
      reply.send(toBudgetView(forecast, summary));
    },
  );

  app.get(
    '/api/verify/:requestId',
    (request: FastifyRequest<{ Params: VerifyParams }>, reply: FastifyReply) => {
      const row = getRequestById(db, request.params.requestId);
      if (!row) {
        reply.code(404).send({ error: 'not_found', requestId: request.params.requestId });
        return;
      }
      reply.send(row);
    },
  );
}
