import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { buildLedger, buildTimeseries, buildWorkspaceStats } from '../ledger/ledger.js';
import {
  COPILOT_PLANS,
  forecastBudget,
  resolveAllowance,
  type Allowance,
  type CopilotPlan,
} from '../ledger/budget.js';
import { getRequestById } from '../store/database.js';
import { buildMcpRoi } from '../waste/report.js';
import { buildWasteBoard } from './waste-detail.js';
import { toBudgetView, toLedgerView } from './view-model.js';
import {
  allScope,
  buildProjectTree,
  describeScope,
  isAtOrBeneath,
  UNATTRIBUTED_REASON_TEXT,
  type ScopeSelection,
  type WorkspaceLocation,
} from '../scope/index.js';
import { canonicalisePath } from '../ingest/redact.js';
import { detectAnomalies, type DailySpend } from '../org/alerts.js';
import { SETTINGS_FIELDS, validateSettingsPatch, type SettingsStore } from './settings.js';
import {
  consentState,
  CONSENT_STATE_TEXT,
  grantConsent,
  readConsent,
  revokeConsent,
} from '../contribute/consent.js';
import {
  auditContribution,
  buildContribution,
  CONTRIBUTION_MANIFEST,
} from '../contribute/contribution.js';
import { listOutbox, outboxDir } from '../contribute/outbox.js';
import {
  availablePeriods,
  buildMonthlyReport,
  renderMonthlyReportMarkdown,
} from '../report/monthly.js';
import type { ConfigLayer } from '../shared/config.js';
import type { PrivacyContext } from '../privacy/scope.js';
import type { DetectContextInputs } from '../waste/context.js';

/**
 * The live dashboard is self-inspection: it binds to 127.0.0.1, requires a
 * per-run token, and shows the machine's owner their own data. Withholding
 * a developer's own sessions from them would protect nobody while removing
 * the detail they need to act.
 *
 * The boundary that matters is what *leaves* the machine — and the
 * exporters (`export.ts`) default to `shared`, where the restrictions bite.
 */
const LOCAL_DASHBOARD_PRIVACY: PrivacyContext = { scope: 'self', subjectCount: 1 };

interface ScopedQuery {
  readonly scope?: string;
  readonly at?: string;
  readonly from?: string;
  readonly to?: string;
  readonly plan?: string;
  readonly allowance?: string;
}

interface VerifyParams {
  readonly requestId: string;
}

interface DayParams {
  readonly day: string;
}

/**
 * A plan from the query string.
 *
 * Falls back rather than erroring, unlike the CLI: this value arrives in a
 * URL the reader can simply retype, whereas a bad plan in a config file is a
 * mistake worth stopping for. The fallback is whatever the server was
 * started with, never a hardcoded plan — mapping every unrecognised value to
 * `enterprise` silently repriced three of the five plans.
 */
function planFromQuery(value: string | undefined, fallback: CopilotPlan): CopilotPlan {
  return COPILOT_PLANS.find((candidate) => candidate === value) ?? fallback;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

/**
 * Defaults the server was started with.
 *
 * The allowance and the workspace map are both resolved **once**, by the
 * CLI — the layer allowed to read config, the environment and the disk —
 * and handed over. Re-reading the workspace map per request would mean a
 * few hundred file reads on every panel refresh, and it also keeps the
 * dashboard and `tokenlens budget` from disagreeing about what is in force.
 */
export interface ApiRouteDefaults {
  readonly allowance?: Allowance | undefined;
  readonly locations?: readonly WorkspaceLocation[] | undefined;
  readonly scope?: ScopeSelection | undefined;
  readonly detectInputs?: DetectContextInputs | undefined;
  /** `defaultRange` from config — the range the dashboard opens on. */
  readonly range?: string | undefined;
  /** Present only when the settings surface is enabled — see `assertWritable`. */
  readonly settings?: SettingsStore | undefined;
  /** The per-run launch token. Writes require it in the header, never the query string. */
  readonly token?: string | undefined;
}

/**
 * The gate on the one route that writes.
 *
 * Everything else here is a GET, and the read-only guarantee used to be
 * checkable just by looking at the route table. Adding a write means that
 * guarantee now has to be *defended* instead, and a server bound to
 * localhost is exactly the target a malicious page in the same browser can
 * reach. Three independent checks, each of which alone would stop the
 * attack:
 *
 * 1. **The token must arrive in the `Authorization` header.** A cross-site
 *    form POST can reach 127.0.0.1 but cannot set a header, and attempting
 *    to forces a CORS preflight the server never answers. `?token=` is
 *    accepted for the initial page load and deliberately *not* here.
 * 2. **`Content-Type` must be `application/json`.** The three content types
 *    a form can send are all rejected, so the simple-request path is closed.
 * 3. **`Origin`, when present, must be this server.** Covers a scripted
 *    fetch from another page, and rejects DNS-rebinding attempts that
 *    resolve an attacker's hostname to 127.0.0.1.
 *
 * Returns a reason when the request must be refused, `undefined` when it may
 * proceed.
 */
function refuseWrite(request: FastifyRequest, defaults: ApiRouteDefaults): string | undefined {
  const auth = request.headers.authorization;
  const supplied = typeof auth === 'string' ? /^Bearer\s+(.+)$/i.exec(auth)?.[1] : undefined;
  if (defaults.token === undefined || supplied !== defaults.token) {
    return 'Writes require the launch token in an Authorization: Bearer header.';
  }

  const contentType = request.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    return 'Writes must be sent as application/json.';
  }

  const origin = request.headers.origin;
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    let hostname: string;
    try {
      hostname = new URL(origin).hostname;
    } catch {
      return 'Unrecognised Origin.';
    }
    if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
      return `Refusing a write from origin ${origin}.`;
    }
  }

  return undefined;
}

/**
 * Resolves a scope from query parameters against the cached workspace map.
 * Pure — no filesystem — precisely because `locations` was resolved up front.
 */
function scopeFromQuery(query: ScopedQuery, defaults: ApiRouteDefaults): ScopeSelection {
  const locations = defaults.locations ?? [];

  if (query.scope === 'all') return allScope(locations.length);
  if (query.scope === undefined && query.at === undefined) {
    return defaults.scope ?? allScope(locations.length);
  }

  const anchor = query.at ?? defaults.scope?.rootDisplayPath;
  if (anchor === undefined) return allScope(locations.length);

  const rootCanonicalPath = canonicalisePath(anchor);
  const matched = locations.filter((location) => {
    if (location.canonicalPath === undefined) return false;
    return query.scope === 'workspace'
      ? location.canonicalPath === rootCanonicalPath
      : isAtOrBeneath(location.canonicalPath, rootCanonicalPath);
  });

  return {
    mode: query.scope === 'workspace' ? 'workspace' : 'folder',
    rootCanonicalPath,
    rootDisplayPath: anchor,
    workspaceIds: new Set(matched.map((location) => location.workspaceId)),
    totalWorkspaceCount: locations.length,
    matchedWorkspaceCount: matched.length,
  };
}

/**
 * A malformed date is refused rather than ignored.
 *
 * Quietly dropping `from=lastweek` would widen the range back to everything
 * and report a total the reader believes is filtered — the same class of
 * silent wrong answer the scope work exists to remove.
 */
function dateRange(query: ScopedQuery): { from?: string; to?: string } | { error: string } {
  for (const [name, value] of [
    ['from', query.from],
    ['to', query.to],
  ] as const) {
    if (value !== undefined && !ISO_DAY.test(value)) {
      return { error: `"${name}" must be an ISO day (YYYY-MM-DD), not ${JSON.stringify(value)}.` };
    }
  }
  if (query.from !== undefined && query.to !== undefined && query.from > query.to) {
    return { error: '"from" is after "to".' };
  }
  return {
    ...(query.from !== undefined ? { from: query.from } : {}),
    ...(query.to !== undefined ? { to: query.to } : {}),
  };
}

function describeScopeForApi(scope: ScopeSelection): Record<string, unknown> {
  return {
    mode: scope.mode,
    rootDisplayPath: scope.rootDisplayPath ?? null,
    matchedWorkspaceCount: scope.matchedWorkspaceCount,
    totalWorkspaceCount: scope.totalWorkspaceCount,
    isEverything: scope.workspaceIds === undefined,
    isEmpty: scope.workspaceIds?.size === 0,
  };
}

/** The preceding window of equal length — never "everything before". */
function precedingWindow(range: { from?: string; to?: string }): { from?: string; to?: string } {
  if (range.from === undefined || range.to === undefined) return {};
  const from = Date.parse(`${range.from}T00:00:00Z`);
  const to = Date.parse(`${range.to}T00:00:00Z`);
  const span = to - from + MS_PER_DAY;
  return {
    from: new Date(from - span).toISOString().slice(0, 10),
    to: new Date(to - span).toISOString().slice(0, 10),
  };
}

/**
 * Registers the JSON API the dashboard's frontend (and `--json`/`--html`
 * exporters — see `export.ts`) consume. Every route is read-only.
 *
 * There is no POST, and that is deliberate: muting a waste finding — the
 * one action a reader might want — is a CLI write, so "this server can only
 * read" stays checkable by looking at the route table.
 */
export function registerApiRoutes(
  app: FastifyInstance,
  db: Database.Database,
  defaults: ApiRouteDefaults = {},
): void {
  // Every handler is synchronous — the whole data path is a synchronous
  // better-sqlite3 read, so there is nothing to await, and marking these
  // `async` would only wrap an already-resolved value in a promise.
  app.get('/api/health', (_request, reply: FastifyReply) => {
    reply.send({ status: 'ok' });
  });

  // The browser cannot read config.json, so the settings that shape the
  // first paint have to be handed to it before that paint happens.
  app.get('/api/defaults', (_request, reply: FastifyReply) => {
    reply.send({ range: defaults.range ?? null });
  });

  app.get(
    '/api/scope',
    (request: FastifyRequest<{ Querystring: ScopedQuery }>, reply: FastifyReply) => {
      const scope = scopeFromQuery(request.query, defaults);
      const tree = buildProjectTree(defaults.locations ?? [], buildWorkspaceStats(db));
      reply.send({
        scope: describeScopeForApi(scope),
        tree: tree.roots,
        unattributed: {
          ...tree.unattributed,
          byReason: tree.unattributed.byReason.map((entry) => ({
            ...entry,
            text: UNATTRIBUTED_REASON_TEXT[entry.reason],
          })),
        },
        totalCredits: tree.totalCredits,
      });
    },
  );

  app.get('/api/projects', (_request, reply: FastifyReply) => {
    const stats = buildWorkspaceStats(db);
    const byId = new Map((defaults.locations ?? []).map((l) => [l.workspaceId, l]));
    const total = stats.reduce((sum, stat) => sum + stat.credits, 0);

    reply.send(
      stats.map((stat) => {
        const location = byId.get(stat.workspaceId);
        return {
          workspaceId: stat.workspaceId,
          label: location?.label ?? null,
          displayPath: location?.displayPath ?? null,
          unattributedReason: location?.unattributedReason ?? null,
          credits: stat.credits,
          measuredCredits: stat.measuredCredits,
          requestCount: stat.requestCount,
          share: total > 0 ? (stat.credits / total) * 100 : 0,
          firstTs: stat.firstTs ?? null,
          lastTs: stat.lastTs ?? null,
          topModel: stat.topModel ?? null,
        };
      }),
    );
  });

  app.get(
    '/api/ledger',
    (request: FastifyRequest<{ Querystring: ScopedQuery }>, reply: FastifyReply) => {
      const range = dateRange(request.query);
      if ('error' in range) {
        reply.code(400).send({ error: 'bad_range', detail: range.error });
        return;
      }
      const scope = scopeFromQuery(request.query, defaults);
      const summary = buildLedger(db, { scope, ...range });
      reply.send({ scope: describeScopeForApi(scope), ...toLedgerView(summary) });
    },
  );

  app.get(
    '/api/timeseries',
    (request: FastifyRequest<{ Querystring: ScopedQuery }>, reply: FastifyReply) => {
      const range = dateRange(request.query);
      if ('error' in range) {
        reply.code(400).send({ error: 'bad_range', detail: range.error });
        return;
      }
      const scope = scopeFromQuery(request.query, defaults);
      reply.send(buildTimeseries(db, { scope, ...range }));
    },
  );

  // Phase D2.7 / D2.8 — deferred from D2 because there was no waste data to
  // render until the attribution engine existed. D13 joins each finding to
  // the remediation, guidance and catalogue data that already existed and
  // was never shown.
  app.get('/api/waste', (_request, reply: FastifyReply) => {
    reply.send(buildWasteBoard(db, LOCAL_DASHBOARD_PRIVACY, defaults.detectInputs ?? {}));
  });

  app.get('/api/mcp-roi', (_request, reply: FastifyReply) => {
    reply.send(buildMcpRoi(db));
  });

  app.get(
    '/api/anomalies',
    (request: FastifyRequest<{ Querystring: ScopedQuery }>, reply: FastifyReply) => {
      const scope = scopeFromQuery(request.query, defaults);
      const summary = buildLedger(db, { scope });
      const series: DailySpend[] = summary.byDay.map((entry) => ({
        day: entry.day,
        credits: entry.credits,
      }));
      // Median absolute deviation, not a standard deviation: an outlier
      // inflates the σ it is measured against until it fits inside it, so a
      // 3σ rule is disabled by the very spike it exists to catch.
      reply.send(detectAnomalies(series));
    },
  );

  app.get(
    '/api/day/:day',
    (request: FastifyRequest<{ Params: DayParams }>, reply: FastifyReply) => {
      const { day } = request.params;
      if (!ISO_DAY.test(day)) {
        reply.code(400).send({ error: 'bad_day', detail: 'Expected YYYY-MM-DD.' });
        return;
      }
      const summary = buildLedger(db, { from: day, to: day });
      reply.send({
        day,
        totalCredits: summary.totalCredits,
        requestCount: summary.requestCount,
        byModel: summary.byModel.map((model) => ({
          model: model.model,
          credits: model.credits,
          requestCount: model.requestCount,
        })),
        byCostCentre: summary.byCostCentre,
        sessions: summary.bySession.slice(0, 20),
      });
    },
  );

  app.get(
    '/api/compare',
    (request: FastifyRequest<{ Querystring: ScopedQuery }>, reply: FastifyReply) => {
      const range = dateRange(request.query);
      if ('error' in range) {
        reply.code(400).send({ error: 'bad_range', detail: range.error });
        return;
      }
      const scope = scopeFromQuery(request.query, defaults);
      const current = buildLedger(db, { scope, ...range });
      const previous = precedingWindow(range);
      const baseline = buildLedger(db, { scope, ...previous });

      reply.send({
        current: {
          ...range,
          credits: current.totalCredits,
          requests: current.requestCount,
          measuredCredits: current.measuredCredits,
        },
        previous: {
          ...previous,
          credits: baseline.totalCredits,
          requests: baseline.requestCount,
          measuredCredits: baseline.measuredCredits,
        },
        deltaCredits: current.totalCredits - baseline.totalCredits,
        deltaPercent:
          baseline.totalCredits > 0
            ? ((current.totalCredits - baseline.totalCredits) / baseline.totalCredits) * 100
            : null,
      });
    },
  );

  app.get(
    '/api/budget',
    async (request: FastifyRequest<{ Querystring: ScopedQuery }>, reply: FastifyReply) => {
      const scope = scopeFromQuery(request.query, defaults);
      const summary = buildLedger(db, { scope });

      // Read the settings store rather than a value frozen at start-up, so a
      // save on the Settings page is reflected on the next request instead of
      // waiting for a restart.
      //
      // But the store only ever reports config-derived values, and a
      // `--allowance` flag outranks the config file. Preferring the store
      // unconditionally silently discarded that flag: the server started with
      // one allowance and every request answered with another.
      const startup = defaults.allowance;
      const live = defaults.settings ? await defaults.settings.read() : undefined;
      const fallback = startup?.source === 'flag' ? startup : (live?.allowance ?? startup);
      const plan = planFromQuery(request.query.plan, fallback?.plan ?? 'enterprise');

      const allowance =
        request.query.allowance !== undefined || fallback === undefined
          ? resolveAllowance({ plan, flag: request.query.allowance })
          : fallback;

      await reply.send(toBudgetView(forecastBudget(summary, allowance), summary));
    },
  );

  // ---------------------------------------------------------------------
  // Settings — the only write surface, and the only non-GET route.
  // ---------------------------------------------------------------------

  app.get('/api/settings', async (_request, reply: FastifyReply) => {
    if (!defaults.settings) {
      await reply.code(404).send({ error: 'settings_disabled' });
      return;
    }
    const current = await defaults.settings.read();
    await reply.send({
      fields: SETTINGS_FIELDS,
      effective: current.effective,
      sources: current.sources,
      project: current.project,
      user: current.user,
      paths: current.paths,
      allowance: {
        credits: current.allowance.credits,
        source: current.allowance.source,
        plan: current.allowance.plan,
      },
      overriddenByEnv: current.overriddenByEnv ?? null,
    });
  });

  app.post(
    '/api/settings',
    async (
      request: FastifyRequest<{ Body: { layer?: string; settings?: unknown } }>,
      reply: FastifyReply,
    ) => {
      if (!defaults.settings) {
        await reply.code(404).send({ error: 'settings_disabled' });
        return;
      }

      const refusal = refuseWrite(request, defaults);
      if (refusal !== undefined) {
        await reply.code(403).send({ error: 'write_refused', detail: refusal });
        return;
      }

      const layer: ConfigLayer = request.body.layer === 'project' ? 'project' : 'user';
      const { value, errors } = validateSettingsPatch(request.body.settings);

      if (errors.length > 0) {
        // Rejected wholesale rather than partially applied: a half-written
        // settings file is harder to reason about than one that refused.
        await reply.code(400).send({ error: 'invalid_settings', detail: errors });
        return;
      }

      const updated = await defaults.settings.write(layer, value);
      await reply.send({
        saved: true,
        layer,
        path: layer === 'user' ? updated.paths.user : updated.paths.project,
        effective: updated.effective,
        sources: updated.sources,
        allowance: {
          credits: updated.allowance.credits,
          source: updated.allowance.source,
        },
        overriddenByEnv: updated.overriddenByEnv ?? null,
      });
    },
  );

  // ---------------------------------------------------------------------
  // Anonymous contribution — consent, and the payload it applies to.
  // ---------------------------------------------------------------------

  app.get('/api/consent', async (_request, reply: FastifyReply) => {
    if (!defaults.settings) {
      await reply.code(404).send({ error: 'settings_disabled' });
      return;
    }
    const state = consentState(await readConsent());
    await reply.send({
      sharing: state.active,
      reason: state.active ? null : state.reason,
      reasonText: state.active ? null : (CONSENT_STATE_TEXT[state.reason] ?? state.reason),
      consentedAt: state.active ? state.record.consentedAt : null,
      contributorId: state.active ? state.record.contributorId : null,
      outbox: outboxDir(),
      produced: await listOutbox(),
      manifest: CONTRIBUTION_MANIFEST,
    });
  });

  // Deliberately readable without consent: agreeing to share something you
  // have not been shown is not consent.
  app.get('/api/consent/preview', async (_request, reply: FastifyReply) => {
    if (!defaults.settings) {
      await reply.code(404).send({ error: 'settings_disabled' });
      return;
    }
    const contribution = buildContribution(db, { contributorId: 'preview-not-yet-assigned' });
    await reply.send({ contribution, audit: auditContribution(contribution) });
  });

  app.post(
    '/api/consent',
    async (request: FastifyRequest<{ Body: { share?: unknown } }>, reply: FastifyReply) => {
      if (!defaults.settings) {
        await reply.code(404).send({ error: 'settings_disabled' });
        return;
      }

      const refusal = refuseWrite(request, defaults);
      if (refusal !== undefined) {
        await reply.code(403).send({ error: 'write_refused', detail: refusal });
        return;
      }

      // Only a literal boolean counts. Anything else is ambiguous, and an
      // ambiguous answer to "may we share your data" is a no.
      if (typeof request.body.share !== 'boolean') {
        await reply
          .code(400)
          .send({ error: 'invalid_consent', detail: 'share must be a boolean.' });
        return;
      }

      if (request.body.share) await grantConsent();
      else await revokeConsent();

      const state = consentState(await readConsent());
      await reply.send({
        sharing: state.active,
        consentedAt: state.active ? state.record.consentedAt : null,
        contributorId: state.active ? state.record.contributorId : null,
      });
    },
  );

  // ---------------------------------------------------------------------
  // Monthly reports — Markdown, built to be handed to an assistant.
  // ---------------------------------------------------------------------

  app.get(
    '/api/reports',
    (request: FastifyRequest<{ Querystring: ScopedQuery }>, reply: FastifyReply) => {
      const scope = scopeFromQuery(request.query, defaults);
      reply.send({ periods: availablePeriods(db, scope) });
    },
  );

  app.get(
    '/api/report',
    async (
      request: FastifyRequest<{ Querystring: ScopedQuery & { period?: string; self?: string } }>,
      reply: FastifyReply,
    ) => {
      const period = request.query.period;
      if (period === undefined || !/^\d{4}-\d{2}$/.test(period)) {
        await reply.code(400).send({ error: 'invalid_period', detail: 'Expected period=YYYY-MM.' });
        return;
      }

      const scope = scopeFromQuery(request.query, defaults);
      const live = defaults.settings ? await defaults.settings.read() : undefined;
      const allowance =
        defaults.allowance?.source === 'flag'
          ? defaults.allowance
          : (live?.allowance ??
            defaults.allowance ?? {
              plan: 'enterprise' as const,
              credits: null,
              source: 'plan-default' as const,
            });

      // A downloaded report is the artefact most likely to be forwarded, so
      // the browser only ever gets the shareable form. `--self` exists on the
      // CLI for a copy that stays put.
      const report = buildMonthlyReport(db, {
        period,
        allowance,
        scope,
        scopeLabel: describeScope(scope),
        privacy: { scope: 'shared', subjectCount: 1 },
      });

      await reply
        .header('content-type', 'text/markdown; charset=utf-8')
        .header('content-disposition', `attachment; filename="tokenlens-${period}.md"`)
        .send(renderMonthlyReportMarkdown(report, db));
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
