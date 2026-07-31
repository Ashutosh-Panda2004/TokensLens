/**
 * The full planned command surface — including commands that are not
 * implemented yet. Registering every planned command from Phase D0 means
 * `tokenlens --help` always reflects the complete product shape, and each
 * later phase only has to attach a real action handler, never restructure
 * the command tree. See DEVELOPMENT-PLAN.md §2 for the phase key.
 *
 * **Now empty.** Every command in the plan has a real implementation as of
 * D6. The list and its machinery are kept because the next phase to add a
 * command surface should register it here first and implement it second —
 * that ordering is what stopped `--help` and the roadmap drifting apart for
 * six phases.
 */
export interface RoadmapCommand {
  readonly name: string;
  readonly summary: string;
  /** Development phase (DEVELOPMENT-PLAN.md §2) that ships this command. */
  readonly phase: string;
}

export const ROADMAP_COMMANDS: readonly RoadmapCommand[] = [];
