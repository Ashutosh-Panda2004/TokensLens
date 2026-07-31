import { buildLedger } from '../ledger/ledger.js';
import { forecastBudget, type CopilotPlan } from '../ledger/budget.js';
import { openDatabase, defaultDatabasePath } from '../store/database.js';
import { formatCredits, formatPercent } from '../waste/format.js';

/**
 * **AUTO-23 · Budget guard** — a minimal MCP server over stdio.
 *
 * ## Why this exists
 *
 * When Copilot credits run out there is no fallback model and no degraded
 * mode: the agent simply stops. A developer three hours into a task
 * discovers this at the worst possible moment. Exposing the remaining
 * allowance as a tool the agent can call means it can say so *before*
 * starting something it cannot finish.
 *
 * ## Why the protocol is implemented here rather than taken as a dependency
 *
 * It is JSON-RPC 2.0 over stdio with three methods, and this server exposes
 * two read-only tools. Against that, an SDK is a large dependency in a
 * product whose entire runtime is five packages, and it would sit on the
 * same stdio contract the hooks already depend on. The handshake is pinned
 * to a protocol version below and the surface is small enough to read in one
 * sitting.
 *
 * As with the hooks: **stdout is the wire**. Every diagnostic goes to
 * stderr, which is why the logger has been stderr-only since D0.
 */
const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'tokenlens-budget-guard';

interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

const TOOLS: readonly McpTool[] = [
  {
    name: 'budget_remaining',
    description:
      'Credits left in the current month against the plan allowance, with the date the run-rate would exhaust it. ' +
      'Call this before starting substantial work: when Copilot credits run out there is no fallback model.',
    inputSchema: {
      type: 'object',
      properties: {
        plan: { type: 'string', enum: ['business', 'enterprise'], description: 'Copilot plan' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'session_cost',
    description:
      'What this workspace has spent so far this month, split by model, so the cost of the current approach is ' +
      'visible before it is repeated.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

export interface McpServerOptions {
  readonly cwd?: string;
  readonly plan?: CopilotPlan;
  readonly now?: Date;
  /** Overrides stdin, for tests. */
  readonly input?: AsyncIterable<string>;
  readonly write?: (line: string) => void;
}

/**
 * Answers one request. Pure over the ledger, so it can be tested without a
 * subprocess or a pipe.
 */
export function handleMcpRequest(
  request: JsonRpcRequest,
  options: McpServerOptions = {},
): Record<string, unknown> | undefined {
  switch (request.method) {
    case 'initialize':
      return result(request, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: '1' },
      });

    case 'notifications/initialized':
      // A notification has no id and expects no reply.
      return undefined;

    case 'tools/list':
      return result(request, { tools: TOOLS });

    case 'tools/call': {
      const name = typeof request.params?.name === 'string' ? request.params.name : '';
      try {
        return result(request, {
          content: [{ type: 'text', text: callTool(name, request.params, options) }],
        });
      } catch (error) {
        // An MCP tool error is reported inside the result, not as a
        // transport error: the agent should see "I could not read the
        // ledger", not a broken connection.
        return result(request, {
          isError: true,
          content: [
            {
              type: 'text',
              text: `TokenLens could not answer: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        });
      }
    }

    default:
      return request.id === undefined
        ? undefined
        : {
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32601, message: `Unknown method: ${request.method}` },
          };
  }
}

function callTool(
  name: string,
  params: Record<string, unknown> | undefined,
  options: McpServerOptions,
): string {
  const db = openDatabase(defaultDatabasePath(options.cwd ?? process.cwd()));
  try {
    const ledger = buildLedger(db);

    if (name === 'session_cost') {
      const top = ledger.byModel.slice(0, 5);
      if (top.length === 0) return 'No spend recorded in this workspace yet.';
      return [
        `${formatCredits(ledger.totalCredits)} credits across ${String(ledger.requestCount)} request(s).`,
        ...top.map(
          (model) =>
            `  ${model.model}: ${formatCredits(model.credits)} credits over ${String(model.requestCount)} request(s)`,
        ),
        `${formatPercent(ledger.measuredCredits / Math.max(1, ledger.totalCredits))} of that is measured; the rest is rate-card estimated.`,
      ].join('\n');
    }

    if (name === 'budget_remaining') {
      const arguments_ = params?.arguments;
      const requested =
        typeof arguments_ === 'object' && arguments_ !== null
          ? (arguments_ as Record<string, unknown>).plan
          : undefined;
      const plan: CopilotPlan =
        requested === 'business' ? 'business' : (options.plan ?? 'enterprise');
      const forecast = forecastBudget(ledger, plan, options.now);
      const remaining = forecast.monthlyAllowance - forecast.monthToDateCredits;

      return [
        `Plan ${forecast.plan}: ${formatCredits(forecast.monthlyAllowance)} credits included per month.`,
        `Spent so far this month: ${formatCredits(forecast.monthToDateCredits)} (day ${String(forecast.daysElapsedInMonth)} of ${String(forecast.daysInMonth)}).`,
        `Remaining: ${formatCredits(Math.max(0, remaining))}.`,
        forecast.onTrackToExceedAllowance
          ? `⚠ At the current rate this month ends at ${formatCredits(forecast.projectedMonthEndCredits)} credits, ` +
            `${formatCredits(forecast.projectedOverage)} over the allowance.`
          : 'On track to stay within the included allowance.',
        forecast.hardBlockDate === undefined
          ? ''
          : `At this rate the allowance is exhausted around ${forecast.hardBlockDate}. There is no fallback model when it is.`,
      ]
        .filter((line) => line !== '')
        .join('\n');
    }

    throw new Error(`Unknown tool: ${name}`);
  } finally {
    db.close();
  }
}

function result(
  request: JsonRpcRequest,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return { jsonrpc: '2.0', id: request.id ?? null, result: payload };
}

/**
 * Runs the server until stdin closes.
 *
 * Messages are newline-delimited JSON, which is what VS Code's stdio
 * transport sends. Malformed lines are skipped rather than fatal: a
 * transport that dies on one bad frame takes the agent's tool surface with
 * it.
 */
export async function runMcpServer(options: McpServerOptions = {}): Promise<void> {
  const write = options.write ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  const source = options.input ?? readLines();

  for await (const line of source) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      continue;
    }
    if (typeof request.method !== 'string') continue;

    const response = handleMcpRequest(request, options);
    if (response) write(JSON.stringify(response));
  }
}

async function* readLines(): AsyncGenerator<string> {
  let buffer = '';
  for await (const chunk of process.stdin) {
    buffer += String(chunk);
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      yield buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
  }
  if (buffer.trim()) yield buffer;
}
