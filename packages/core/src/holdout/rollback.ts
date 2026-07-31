import type { Artefact } from '../policy/artefacts.js';
import type { GuardrailBreach } from './metrics.js';

/**
 * **D8.8 · AUTO-26 — automatic rollback.**
 *
 * ## Why this is mechanical and not a decision
 *
 * A guardrail breach means the policy is costing more than it saves in a
 * currency that is not credits. The correct response is to revert. Everyone
 * agrees with that in advance and nobody does it in the moment, because in
 * the moment the argument is always the same and always reasonable: *it is
 * probably noise, let us give it one more week*. One more week becomes a
 * quarter, and by then reverting would mean admitting the quarter was
 * wasted.
 *
 * So the rollback is not proposed for discussion. It is executed, and the
 * discussion happens afterwards with the policy already off. This costs
 * something real — occasionally a good policy will be reverted by a noisy
 * fortnight — and that cost is paid deliberately, because the alternative
 * failure is unbounded and invisible.
 *
 * The two protections against over-firing live in `metrics.ts`, not here: a
 * breach needs both a threshold crossing and a minimum number of
 * observations. By the time a breach reaches this module it has already
 * earned its rollback.
 *
 * ## Why this module executes nothing
 *
 * It selects the artefacts and returns them. Writing to a machine's managed
 * settings is D5's job, and it is done through the same reviewed emission
 * path as the original deployment. A rollback that took a private shortcut
 * to the registry would be a second, less tested, deployment mechanism —
 * and it would be the one that only ever runs during an incident.
 */
export type RollbackDecision = 'hold' | 'revert';

export interface RollbackAssessment {
  readonly decision: RollbackDecision;
  readonly breaches: readonly GuardrailBreach[];
  /** Inverse artefacts to apply. Empty when holding, or when no inverse exists. */
  readonly artefacts: readonly Artefact[];
  readonly detail: string;
  /**
   * Set when a revert is warranted but cannot be performed automatically —
   * the loudest possible failure, because a silent one leaves a harmful
   * policy in place while the log says "rollback".
   */
  readonly manualActionRequired: string | undefined;
}

export interface RollbackOptions {
  /** All artefacts from the emission that deployed the policy. */
  readonly artefacts?: readonly Artefact[];
}

export function assessRollback(
  breaches: readonly GuardrailBreach[],
  options: RollbackOptions = {},
): RollbackAssessment {
  if (breaches.length === 0) {
    return {
      decision: 'hold',
      breaches,
      artefacts: [],
      detail: 'No guardrail breached. The policy stays in place.',
      manualActionRequired: undefined,
    };
  }

  const inverses = (options.artefacts ?? []).filter((artefact) => artefact.role === 'rollback');
  const worst = [...breaches].sort((a, b) => b.adverseMovement - a.adverseMovement)[0];

  const detail =
    `${String(breaches.length)} guardrail(s) breached. Reverting the policy without waiting for agreement: ` +
    (worst ? worst.detail : '') +
    ' The revert is automatic by design — the argument for waiting is always available and always sounds reasonable.';

  if (inverses.length === 0) {
    return {
      decision: 'revert',
      breaches,
      artefacts: [],
      detail,
      manualActionRequired:
        'A revert is warranted but no rollback artefact was supplied, so nothing can be applied ' +
        'automatically. Re-run `tokenlens policy emit --out <dir>` against the deployed policy to ' +
        'regenerate the inverse, and apply it by hand. Until that is done the policy is still live.',
    };
  }

  return {
    decision: 'revert',
    breaches,
    artefacts: inverses,
    detail,
    manualActionRequired: undefined,
  };
}
