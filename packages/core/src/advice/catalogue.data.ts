import type { CatalogueEntry } from './catalogue.js';

/**
 * D11 \u2014 the v1 curated catalogue.
 *
 * Eight entries. Not thirty, and the shortfall is the finding rather than an
 * omission: of the seven implemented waste detectors, three are already fixed by
 * a managed setting or a runtime guard, two are habits, and exactly two leave a
 * residual a third-party tool could address. Entries that can never fire are not
 * coverage, they are unvetted liability with a licence to re-check and a
 * maintainer to chase.
 *
 * Three entries below are `deprecated`. They are retained on purpose: the engine
 * refuses them *by name*, and the curation process gets regression fixtures that
 * are real rather than invented. Two of them are among the best-known projects
 * in this space, which is exactly why a catalogue assembled from search rankings
 * or star counts would have led with them.
 *
 * Every fact carries its provenance. Nothing here is `maintainer-verified` yet,
 * so `catalogueReadiness()` reports `guidance-only` and the CLI names no tool
 * until a human signs off. That is the intended starting state, not a defect.
 *
 * See D11-PRESCRIPTIVE-ADVICE.md \u00a73 and \u00a76.
 */
export const CATALOGUE: readonly CatalogueEntry[] = [
  {
    id: 'serena',
    name: 'Serena',
    repository: 'https://github.com/oraios/serena',
    summary:
      'An MCP server that gives the agent language-server-backed symbol lookup, so it can ask ' +
      'for one function instead of reading a whole file.',
    licence: 'MIT',
    mechanisms: ['symbol-scoped-retrieval'],
    surfaces: ['mcp-server'],
    addresses: ['W2', 'W3'],
    wouldAddress: [],
    install: {
      command: 'uv tool install -p 3.13 serena-agent',
      complexity: 'config-edit',
      reversible: true,
    },
    requiresLocalModel: false,
    status: 'caution',
    statusReason:
      'Facts read directly from the repository page but not yet signed off by a named ' +
      'maintainer, so rule 7 of the inclusion bar is unmet. Also note the install pulls a ' +
      'language server per language, which is more than one line however reversible it is.',
    evidence: 'mechanism',
    verification: {
      checkedOn: '2026-08-01',
      checkedBy: 'unsigned \u2014 awaiting maintainer sign-off',
      upstreamLastRelease: { date: '2026-07-18', precision: 'day', tag: 'v1.6.1' },
      upstreamLastCommit: { date: '2026-08-01', precision: 'day', tag: undefined },
      source: 'primary-fetch',
    },
  },
  {
    id: 'repomix',
    name: 'Repomix',
    repository: 'https://github.com/yamadashy/repomix',
    summary:
      'Packs a repository into one bounded, token-counted bundle, and can strip function bodies ' +
      'with tree-sitter while keeping signatures.',
    licence: 'MIT',
    mechanisms: ['structural-compression', 'bounded-context-packing'],
    surfaces: ['cli', 'mcp-server'],
    addresses: ['W3'],
    wouldAddress: [],
    install: {
      command: 'npx repomix@latest',
      complexity: 'one-line',
      reversible: true,
    },
    requiresLocalModel: false,
    status: 'caution',
    statusReason:
      'Facts read directly from the repository page but not yet signed off by a named ' +
      'maintainer, so rule 7 of the inclusion bar is unmet.',
    evidence: 'upstream-claim',
    verification: {
      checkedOn: '2026-08-01',
      checkedBy: 'unsigned \u2014 awaiting maintainer sign-off',
      upstreamLastRelease: { date: '2026-07-18', precision: 'day', tag: 'v1.17.0' },
      upstreamLastCommit: { date: '2026-08-01', precision: 'day', tag: undefined },
      source: 'primary-fetch',
    },
  },
  {
    id: 'ast-grep',
    name: 'ast-grep',
    repository: 'https://github.com/ast-grep/ast-grep',
    summary:
      'Structural search over the syntax tree, so a query returns the matching nodes rather than ' +
      'every file that happened to contain the string.',
    licence: 'MIT',
    mechanisms: ['symbol-scoped-retrieval', 'structural-compression'],
    surfaces: ['cli'],
    addresses: ['W2', 'W3'],
    wouldAddress: [],
    install: {
      command: 'npm install --global @ast-grep/cli',
      complexity: 'one-line',
      reversible: true,
    },
    requiresLocalModel: false,
    status: 'caution',
    statusReason:
      'Metadata came from a secondary summary, not a primary fetch. Owner, licence and install ' +
      'command must be confirmed against the repository before this may be offered \u2014 those are ' +
      'exactly the fields automated collection got wrong elsewhere in this pass. The dates below ' +
      'are reported rather than observed and are recorded to the day only because the report was.',
    evidence: 'mechanism',
    verification: {
      checkedOn: '2026-08-01',
      checkedBy: 'unsigned \u2014 awaiting maintainer sign-off',
      upstreamLastRelease: { date: '2026-07-25', precision: 'day', tag: '0.45.0' },
      upstreamLastCommit: { date: '2026-07-29', precision: 'day', tag: undefined },
      source: 'reported-unverified',
    },
  },
  {
    id: 'code2prompt',
    name: 'code2prompt',
    repository: 'https://github.com/mufeedvh/code2prompt',
    summary:
      'Builds a templated, token-counted prompt from a codebase so the size of the context is ' +
      'chosen rather than discovered.',
    licence: 'MIT',
    mechanisms: ['bounded-context-packing'],
    surfaces: ['cli', 'mcp-server'],
    addresses: ['W3'],
    wouldAddress: [],
    install: {
      command: 'cargo install code2prompt',
      complexity: 'one-line',
      reversible: true,
    },
    requiresLocalModel: false,
    status: 'caution',
    statusReason:
      'Metadata came from a secondary summary, not a primary fetch. The reported release is ' +
      'roughly eight months old, which is inside rule 2 but close enough to warrant a look. Both ' +
      'dates below are known to the month only, so freshness derived from them is approximate.',
    evidence: 'mechanism',
    verification: {
      checkedOn: '2026-08-01',
      checkedBy: 'unsigned \u2014 awaiting maintainer sign-off',
      upstreamLastRelease: { date: '2025-12-01', precision: 'month', tag: 'v4.2.0' },
      upstreamLastCommit: { date: '2026-06-01', precision: 'month', tag: undefined },
      source: 'reported-unverified',
    },
  },
  {
    id: 'octocode-mcp',
    name: 'octocode-mcp',
    repository: 'https://github.com/bgauryy/octocode-mcp',
    summary:
      'An MCP server combining local and repository search with language-server semantics, ' +
      'returning compacted context rather than whole files.',
    licence: 'MIT',
    mechanisms: ['symbol-scoped-retrieval', 'bounded-context-packing'],
    surfaces: ['mcp-server'],
    addresses: ['W2', 'W3'],
    wouldAddress: [],
    install: {
      command: 'npx octocode --help',
      complexity: 'config-edit',
      reversible: true,
    },
    requiresLocalModel: false,
    status: 'caution',
    statusReason:
      'Metadata came from a secondary summary. Also the smallest project in the catalogue by a ' +
      'wide margin, with a reported release roughly eight months old; a single-maintainer ' +
      'project at that size is a real continuity risk for an enterprise recommendation.',
    evidence: 'mechanism',
    verification: {
      checkedOn: '2026-08-01',
      checkedBy: 'unsigned \u2014 awaiting maintainer sign-off',
      upstreamLastRelease: { date: '2025-12-01', precision: 'month', tag: '9.1.1' },
      upstreamLastCommit: { date: '2026-07-25', precision: 'day', tag: undefined },
      source: 'reported-unverified',
    },
  },

  // ---------------------------------------------------------------------------
  // Refused, and kept so the refusal is by name rather than by silence.
  // ---------------------------------------------------------------------------

  {
    id: 'gptcache',
    name: 'GPTCache',
    repository: 'https://github.com/zilliztech/GPTCache',
    summary:
      'A semantic cache for LLM queries, reusing the answer to a sufficiently similar question.',
    licence: 'MIT',
    mechanisms: ['semantic-cache'],
    surfaces: ['library'],
    addresses: [],
    wouldAddress: ['W8'],
    install: {
      command: 'pip install gptcache',
      complexity: 'multi-step',
      reversible: true,
    },
    requiresLocalModel: true,
    status: 'deprecated',
    statusReason:
      'Upstream says so itself: "we no longer add support for new API or models". Last release ' +
      'two years before checkedOn, last commit over a year, which fails rule 2 twice over. ' +
      'Ships only as a library, which fails rule 4. Its mechanism targets W8, which has no ' +
      'detector yet. Retained because a catalogue built on stars would have led with it.',
    evidence: 'upstream-claim',
    verification: {
      checkedOn: '2026-08-01',
      checkedBy: 'unsigned \u2014 awaiting maintainer sign-off',
      upstreamLastRelease: { date: '2024-08-01', precision: 'month', tag: 'v0.1.44' },
      upstreamLastCommit: { date: '2025-08-01', precision: 'month', tag: undefined },
      source: 'primary-fetch',
    },
  },
  {
    id: 'routellm',
    name: 'RouteLLM',
    repository: 'https://github.com/lm-sys/RouteLLM',
    summary: 'Routes simpler queries to a cheaper model and harder ones to a stronger model.',
    licence: 'Apache-2.0',
    mechanisms: ['model-routing'],
    surfaces: ['proxy', 'library'],
    addresses: [],
    wouldAddress: ['W5'],
    install: {
      command: 'pip install "routellm[serve,eval]"',
      complexity: 'multi-step',
      reversible: false,
    },
    requiresLocalModel: true,
    status: 'deprecated',
    statusReason:
      'Refused on three independent grounds. It targets W5, which a tier-A routing setting ' +
      'already fixes, so there is no residual to offer it against. It ships as a proxy, which ' +
      'would put a man-in-the-middle over every prompt. And its last commit was two years ' +
      'before checkedOn with no release ever published. It is the obvious candidate for W5 and ' +
      'it is the clearest illustration of why obviousness is not the gate.',
    evidence: 'upstream-claim',
    verification: {
      checkedOn: '2026-08-01',
      checkedBy: 'unsigned \u2014 awaiting maintainer sign-off',
      upstreamLastRelease: undefined,
      upstreamLastCommit: { date: '2024-08-01', precision: 'month', tag: undefined },
      source: 'primary-fetch',
    },
  },
  {
    id: 'llmlingua',
    name: 'LLMLingua',
    repository: 'https://github.com/microsoft/LLMLingua',
    summary:
      'Compresses a prompt by running a small language model over it and dropping the tokens it ' +
      'judges non-essential.',
    licence: 'MIT',
    mechanisms: ['prompt-compression'],
    surfaces: ['library'],
    addresses: [],
    wouldAddress: ['W9'],
    install: {
      command: 'pip install llmlingua',
      complexity: 'multi-step',
      reversible: true,
    },
    requiresLocalModel: true,
    status: 'deprecated',
    statusReason:
      'Genuinely strong research, and still refused. Its last release was two years before ' +
      'checkedOn, failing rule 2. It ships as a library, failing rule 4. It requires a GPT2- or ' +
      'BERT-class model to be downloaded and run over the prompt, which is a second thing ' +
      'reading the developer\u2019s context. And its mechanism targets prompt bloat, which this ' +
      'taxonomy classes as behavioural: compression treats the symptom of a session nobody ended.',
    evidence: 'upstream-claim',
    verification: {
      checkedOn: '2026-08-01',
      checkedBy: 'unsigned \u2014 awaiting maintainer sign-off',
      upstreamLastRelease: { date: '2024-08-01', precision: 'month', tag: 'v0.2.2' },
      upstreamLastCommit: { date: '2025-10-01', precision: 'month', tag: undefined },
      source: 'primary-fetch',
    },
  },
];
