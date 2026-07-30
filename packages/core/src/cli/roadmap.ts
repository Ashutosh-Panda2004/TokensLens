/**
 * The full planned command surface — including commands that are not
 * implemented yet. Registering every planned command from Phase D0 means
 * `tokenlens --help` always reflects the complete product shape, and each
 * later phase only has to attach a real action handler, never restructure
 * the command tree. See DEVELOPMENT-PLAN.md §2 for the phase key.
 */
export interface RoadmapCommand {
  readonly name: string;
  readonly summary: string;
  /** Development phase (DEVELOPMENT-PLAN.md §2) that ships this command. */
  readonly phase: 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6';
}

export const ROADMAP_COMMANDS: readonly RoadmapCommand[] = [
  {
    name: 'ledger',
    summary: 'Show the exact credit ledger by day, model, and cost centre.',
    phase: 'D1',
  },
  {
    name: 'verify',
    summary: 'Print the source file and byte offset backing a figure.',
    phase: 'D1',
  },
  {
    name: 'dashboard',
    summary: 'Start the local read-only reporting dashboard.',
    phase: 'D2',
  },
  {
    name: 'waste',
    summary: 'Rank measured waste by cause, with named remediation.',
    phase: 'D3',
  },
  {
    name: 'simulate',
    summary: 'Replay recorded sessions under an alternative policy.',
    phase: 'D4',
  },
  {
    name: 'policy',
    summary: 'Detect the active settings channel and emit a policy artefact.',
    phase: 'D5',
  },
  {
    name: 'hook',
    summary: 'Runtime hook entry point invoked by the Copilot agent.',
    phase: 'D6',
  },
  {
    name: 'mcp',
    summary: 'Run the budget-guard MCP server over stdio.',
    phase: 'D6',
  },
];
