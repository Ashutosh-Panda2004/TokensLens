import type { Policy } from '../simulate/policy.js';
import type { RequestRow } from '../store/database.js';

/**
 * **D8.6 · AUTO-25 — the override monitor.**
 *
 * ## Why this is the most important guardrail
 *
 * Every other guardrail measures whether the policy hurt output. This one
 * measures whether developers *believe* it hurt them — and it does so
 * without asking, which matters because asking produces answers about the
 * policy's visibility rather than its effect.
 *
 * A model routing policy sets a default. It does not remove the model
 * picker. If the routing is wrong — if the cheaper model genuinely cannot
 * do the work — developers will quietly switch back, one request at a time,
 * and the credit saving will evaporate while the dashboard still shows the
 * policy as "applied". The override rate is the difference between a policy
 * that is deployed and a policy that is *accepted*.
 *
 * It is behavioural, so it cannot be answered politely. It is measured from
 * the ledger the developer never sees, so it cannot be gamed. And it needs
 * no survey, which is the only reason it will still be measured in six
 * months.
 *
 * ## What counts, and what does not
 *
 * Anything the policy sanctions is not an override: the default, every
 * model a routing rule can send work to, and the utility model. A request
 * on any *other* model is a developer reaching past the routing decision —
 * including a model that did not exist when the policy was written, since
 * choosing it over the default is the same act regardless of its release
 * date.
 *
 * Requests that predate the deployment are excluded entirely. Counting
 * them would blend the behaviour the policy was meant to change into the
 * measurement of whether it changed, and the rate would improve by simply
 * waiting.
 */
export interface OverrideOptions {
  /** Only requests at or after this instant, i.e. after the policy took effect. */
  readonly since?: number;
}

export interface ModelOverride {
  readonly model: string;
  readonly requests: number;
  readonly share: number;
}

export interface OverrideReport {
  /** Model the policy routes to by default. `undefined` when the policy sets none. */
  readonly routedModel: string | undefined;
  readonly requestsConsidered: number;
  readonly onRoutedModel: number;
  readonly overrides: number;
  /** `undefined` when there is nothing to measure against, never 0 as a stand-in. */
  readonly overrideRate: number | undefined;
  readonly byModel: readonly ModelOverride[];
  readonly detail: string;
}

/**
 * Reads the ledger, not the settings.
 *
 * `policy verify` already answers "did the setting land". This answers the
 * different and harder question of whether it survived contact with the
 * people it landed on, and only observed requests can say that.
 */
export function measureOverrides(
  requests: readonly RequestRow[],
  policy: Policy,
  options: OverrideOptions = {},
): OverrideReport {
  const routed = policy.model?.default;
  const since = options.since ?? 0;
  const considered = requests.filter((request) => request.ts >= since);

  if (routed === undefined) {
    return {
      routedModel: undefined,
      requestsConsidered: considered.length,
      onRoutedModel: 0,
      overrides: 0,
      overrideRate: undefined,
      byModel: tally(considered),
      detail:
        'The policy does not set a default model, so there is nothing to override and no rate to report. ' +
        'This is not a zero override rate — it is the absence of a routing decision.',
    };
  }

  // Routed alternatives are part of the policy, not defiance of it.
  const sanctioned = new Set<string>([
    routed,
    ...(policy.model?.route ?? []).map((rule) => rule.to),
  ]);
  if (policy.model?.utility !== undefined) sanctioned.add(policy.model.utility);

  const onRouted = considered.filter((request) => sanctioned.has(request.model)).length;
  const overrides = considered.length - onRouted;
  const rate = considered.length > 0 ? overrides / considered.length : undefined;

  return {
    routedModel: routed,
    requestsConsidered: considered.length,
    onRoutedModel: onRouted,
    overrides,
    overrideRate: rate,
    byModel: tally(considered),
    detail:
      rate === undefined
        ? 'No requests observed since the policy took effect, so the override rate is unknown.'
        : rate === 0
          ? `Every one of ${String(considered.length)} request(s) used a model the policy sanctions. ` +
            'The routing is being accepted, which is the strongest available evidence that it is not costing anyone time.'
          : `${(rate * 100).toFixed(1)}% of ${String(considered.length)} request(s) used a model outside the policy. ` +
            'Developers reaching past a routing decision is the cheapest possible signal that the routing is wrong; ' +
            'the credits it was supposed to save are not being saved either.',
  };
}

function tally(requests: readonly RequestRow[]): ModelOverride[] {
  const counts = new Map<string, number>();
  for (const request of requests) counts.set(request.model, (counts.get(request.model) ?? 0) + 1);

  const total = requests.length;
  return [...counts.entries()]
    .map(([model, count]) => ({
      model,
      requests: count,
      share: total > 0 ? count / total : 0,
    }))
    .sort((a, b) => b.requests - a.requests);
}
