/**
 * **D8.3–D8.5 — what is being measured, and the one substitution that would
 * quietly invalidate the whole programme.**
 *
 * ## The trap
 *
 * The obvious primary metric is **credits per merged pull request**. It is
 * easy, it is available, and it is wrong — dangerously wrong, because it
 * moves in the right direction for the wrong reason.
 *
 * Credits per merged PR falls when developers *stop using Copilot*. A team
 * that abandons the tool entirely reports a perfect score. So a metric
 * introduced to prove the tool is worth buying will reward its
 * abandonment, and nobody will notice because the chart points the right
 * way. Cost per unit of output measures **cost efficiency**, not
 * productivity, and the two come apart exactly when it matters most.
 *
 * The primary metric is therefore **human effort per durable change**: the
 * hours a person spends to produce one change that survives a stated
 * horizon without revert or substantial rework. It cannot be inflated by
 * shipping more, because the denominator only counts what lasted; and it
 * cannot be gamed by using the tool less, because the numerator is human
 * time.
 *
 * Credits-per-anything is kept, demoted to **secondary**, and carries the
 * warning above wherever it is rendered.
 */

export type MetricRole = 'primary' | 'secondary' | 'guardrail';
export type MetricDirection = 'lower-is-better' | 'higher-is-better';

export interface MetricDefinition {
  readonly id: string;
  readonly name: string;
  readonly role: MetricRole;
  readonly direction: MetricDirection;
  readonly unit: string;
  readonly definition: string;
  /** Only guardrails have one: the relative movement that triggers AUTO-26. */
  readonly breachThreshold?: number;
  /** Minimum observations per arm before the metric is allowed to say anything. */
  readonly minimumObservations: number;
  readonly caveat?: string;
}

export const PRIMARY_METRIC: MetricDefinition = {
  id: 'effort-per-durable-change',
  name: 'Human effort per durable change',
  role: 'primary',
  direction: 'lower-is-better',
  unit: 'hours',
  definition:
    'Measurable author hours divided by the number of changes surviving the horizon without revert. ' +
    'A durable change is the unit of output that cannot be inflated by shipping more.',
  minimumObservations: 20,
  caveat:
    'Review hours are not in git and are excluded from the numerator. The measure is therefore a ' +
    'lower bound on total effort, and a policy that moves work into review will understate its own cost.',
};

export const SECONDARY_METRICS: readonly MetricDefinition[] = [
  {
    id: 'credits-per-developer-month',
    name: 'Credits per developer per month',
    role: 'secondary',
    direction: 'lower-is-better',
    unit: 'credits',
    definition: 'Total credits divided by active developers and elapsed months.',
    minimumObservations: 5,
    caveat:
      'This is a cost metric, not a productivity metric. It falls when the tool is used less, which is ' +
      'a loss reported as a win. Never read it without the primary metric beside it.',
  },
  {
    id: 'credits-per-durable-change',
    name: 'Credits per durable change',
    role: 'secondary',
    direction: 'lower-is-better',
    unit: 'credits',
    definition: 'Credits divided by changes surviving the horizon.',
    minimumObservations: 20,
    caveat:
      'Cost efficiency, not productivity. Improves both when the tool gets cheaper and when it gets abandoned.',
  },
  {
    id: 'cost-centre-mix',
    name: 'Cost-centre mix',
    role: 'secondary',
    direction: 'lower-is-better',
    unit: 'share of prompt tokens',
    definition:
      'Share of prompt tokens spent on tool definitions, history and retrieved content rather than the request.',
    minimumObservations: 50,
  },
];

/**
 * Guardrails exist to catch the failure mode nobody plans for: the policy
 * saves money by making people slower, and the savings report is delighted.
 * A breach reverts the policy automatically (AUTO-26) — see `rollback.ts`
 * for why that is not a judgement call.
 */
export const GUARDRAIL_METRICS: readonly MetricDefinition[] = [
  {
    id: 'pr-throughput',
    name: 'Merged pull requests per developer per week',
    role: 'guardrail',
    direction: 'higher-is-better',
    unit: 'PRs/dev/week',
    definition: 'Merge commits carrying a pull-request reference, per active author, per week.',
    breachThreshold: 0.1,
    minimumObservations: 20,
  },
  {
    id: 'cycle-time',
    name: 'Cycle time',
    role: 'guardrail',
    direction: 'lower-is-better',
    unit: 'hours',
    definition: 'Hours from first commit on a branch to the merge that lands it.',
    breachThreshold: 0.2,
    minimumObservations: 20,
  },
  {
    id: 'revert-rate-7d',
    name: '7-day revert rate',
    role: 'guardrail',
    direction: 'lower-is-better',
    unit: 'share of changes',
    definition: 'Share of changes reverted within seven days of landing.',
    breachThreshold: 0.5,
    minimumObservations: 30,
  },
  {
    id: 'model-override-rate',
    name: 'Model override rate',
    role: 'guardrail',
    direction: 'lower-is-better',
    unit: 'share of requests',
    definition:
      'Share of requests issued on a model other than the one the policy routes to. AUTO-25 — see override.ts.',
    breachThreshold: 0.25,
    minimumObservations: 50,
  },
];

export interface UnavailableMetric {
  readonly id: string;
  readonly name: string;
  readonly reason: string;
  readonly unblockedBy: string;
}

/**
 * D8.5 lists chat abandonment as a guardrail. It is not built, because it
 * is not measurable from anything TokenLens can see, and a guardrail that
 * silently reads zero is worse than an absent one — it will be pointed at
 * as evidence that nothing went wrong.
 */
export const UNAVAILABLE_METRICS: readonly UnavailableMetric[] = [
  {
    id: 'chat-abandonment',
    name: 'Chat abandonment',
    reason:
      'Abandonment means the developer gave up. The journal records a session ending, which happens ' +
      'identically when the task succeeded, when the window was closed, and when the laptop slept. ' +
      'No field distinguishes them.',
    unblockedBy:
      'An explicit outcome signal on session close, or an accepted/rejected marker on the final response.',
  },
  {
    id: 'developer-satisfaction',
    name: 'Developer satisfaction',
    reason:
      'Self-reported and therefore reactive to the policy being visible. It also cannot be collected ' +
      'without asking, which is exactly the survey this design set out to replace.',
    unblockedBy:
      'Nothing TokenLens should build. If it is needed, run it as a separate blinded study.',
  },
];

export interface MetricObservation {
  readonly metric: string;
  /** Level in the control arm, or the pre-period, depending on the comparison. */
  readonly baseline: number;
  readonly current: number;
  readonly observations: number;
}

export interface GuardrailBreach {
  readonly metric: string;
  readonly name: string;
  readonly baseline: number;
  readonly current: number;
  /** Signed so the direction is legible: positive means the metric moved the wrong way. */
  readonly adverseMovement: number;
  readonly threshold: number;
  readonly detail: string;
}

export interface GuardrailAssessment {
  readonly breaches: readonly GuardrailBreach[];
  readonly assessed: readonly string[];
  readonly underpowered: readonly string[];
  readonly missing: readonly string[];
}

/**
 * A breach requires both a movement past the threshold **and** enough
 * observations to believe it.
 *
 * Without the second condition a three-commit week would revert a fleet
 * policy, the revert would be indistinguishable from the guardrail working,
 * and within a month nobody would trust the mechanism enough to leave it
 * armed. An automatic rollback is only useful while people still believe it
 * fires for a reason.
 */
export function evaluateGuardrails(
  observations: readonly MetricObservation[],
  definitions: readonly MetricDefinition[] = GUARDRAIL_METRICS,
): GuardrailAssessment {
  const byId = new Map(observations.map((o) => [o.metric, o]));
  const breaches: GuardrailBreach[] = [];
  const assessed: string[] = [];
  const underpowered: string[] = [];
  const missing: string[] = [];

  for (const definition of definitions) {
    const observation = byId.get(definition.id);
    if (!observation) {
      missing.push(definition.id);
      continue;
    }
    if (observation.observations < definition.minimumObservations) {
      underpowered.push(definition.id);
      continue;
    }
    assessed.push(definition.id);

    if (observation.baseline === 0) continue;
    const relative = (observation.current - observation.baseline) / Math.abs(observation.baseline);
    const adverse = definition.direction === 'lower-is-better' ? relative : -relative;
    const threshold = definition.breachThreshold ?? Number.POSITIVE_INFINITY;
    if (adverse <= threshold) continue;

    breaches.push({
      metric: definition.id,
      name: definition.name,
      baseline: observation.baseline,
      current: observation.current,
      adverseMovement: adverse,
      threshold,
      detail:
        `${definition.name} moved ${(adverse * 100).toFixed(1)}% in the wrong direction ` +
        `(${observation.baseline.toFixed(3)} → ${observation.current.toFixed(3)}), past the ` +
        `${(threshold * 100).toFixed(0)}% guardrail over ${String(observation.observations)} observation(s).`,
    });
  }

  return { breaches, assessed, underpowered, missing };
}

export const COST_EFFICIENCY_WARNING =
  'Cost per unit of output measures cost efficiency, not productivity. It improves when the tool ' +
  'becomes cheaper and equally when it stops being used, and only the primary metric can tell those apart.';
