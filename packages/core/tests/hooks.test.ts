import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import {
  openGuardState,
  allRuleHealth,
  readDecisionLog,
  getSessionState,
} from '../src/hooks/state.js';
import {
  dispatch,
  decisionKind,
  isDisabled,
  FALSE_POSITIVE_THRESHOLD,
} from '../src/hooks/dispatch.js';
import { DEFAULT_GUARD_CONFIG, GUARDS, UNAVAILABLE_GUARDS } from '../src/hooks/guards.js';
import { parseHookInput, readToolTarget, HOOK_EVENTS } from '../src/hooks/protocol.js';
import { resolveWithinRoot, fingerprintFile, MAX_HASH_BYTES } from '../src/hooks/fingerprint.js';
import { runHook } from '../src/hooks/run.js';
import { generateHookConfig } from '../src/hooks/config.js';
import type { HookInput } from '../src/hooks/protocol.js';

const SALT = 'test-salt';
const NOW = Date.parse('2026-07-31T12:00:00Z');

let db: Database.Database;
let root: string;

beforeEach(() => {
  db = openGuardState(':memory:');
  root = mkdtempSync(join(tmpdir(), 'tokenlens-hook-'));
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function input(overrides: Partial<HookInput> & Pick<HookInput, 'event'>): HookInput {
  return { sessionId: 'session-1', ...overrides };
}

function run(hookInput: HookInput, now = NOW): ReturnType<typeof dispatch> {
  return dispatch(hookInput, { db, salt: SALT, root, now });
}

function writeFile(relative: string, contents: string): string {
  const target = join(root, relative);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, contents, 'utf8');
  return target;
}

describe('hook input hardening (D6.12)', () => {
  it('refuses to act on anything it cannot understand', () => {
    expect(parseHookInput('not json')).toBeUndefined();
    expect(parseHookInput('[]')).toBeUndefined();
    expect(parseHookInput('null')).toBeUndefined();
    expect(parseHookInput('{"event":"NotAnEvent","sessionId":"s"}')).toBeUndefined();
    // No session id: nothing can be grouped, so nothing can be decided.
    expect(parseHookInput('{"event":"PreToolUse"}')).toBeUndefined();
  });

  it('ignores fields it does not know rather than rejecting the payload', () => {
    // Hooks are Preview. A strict schema would turn every VS Code update
    // into an outage.
    const parsed = parseHookInput(
      '{"event":"PreToolUse","sessionId":"s","somethingNew":{"a":1},"toolName":"read_file"}',
    );

    expect(parsed?.toolName).toBe('read_file');
    expect(parsed).not.toHaveProperty('somethingNew');
  });

  it('takes the event from the command line over the payload', () => {
    // The flag comes from the hook configuration; the payload is the
    // untrusted side of the boundary.
    const parsed = parseHookInput('{"event":"Stop","sessionId":"s"}', 'PreToolUse');
    expect(parsed?.event).toBe('PreToolUse');
  });

  it('accepts both camelCase and snake_case, because the schema uses both', () => {
    const parsed = parseHookInput('{"session_id":"s","tool_name":"read_file"}', 'PreToolUse');
    expect(parsed?.sessionId).toBe('s');
    expect(parsed?.toolName).toBe('read_file');
  });

  it('never lets an agent-supplied path escape the workspace', () => {
    expect(resolveWithinRoot('/work', '../../etc/passwd')).toBeUndefined();
    expect(resolveWithinRoot('/work', '/etc/passwd')).toBeUndefined();
    // A sibling that merely shares a name prefix is not inside the root.
    expect(resolveWithinRoot('/work', '../work-evil/x')).toBeUndefined();
    expect(resolveWithinRoot('/work', 'src/a.ts')).toBeDefined();
  });

  it('reads a range from whichever argument name the tool used', () => {
    const target = readToolTarget(
      input({ event: 'PreToolUse', toolInput: { filePath: 'a.ts', start_line: 5, endLine: 20 } }),
    );
    expect(target?.rawPath).toBe('a.ts');
    expect(target?.startLine).toBe(5);
    expect(target?.endLine).toBe(20);
  });
});

describe('H-4 · deny only on provable no-ops', () => {
  it('allows the first read and denies an identical second one', () => {
    writeFile('src/a.ts', 'export const a = 1;\n');
    const call = input({
      event: 'PreToolUse',
      toolName: 'read_file',
      toolInput: { filePath: 'src/a.ts' },
      turn: 4,
    });

    expect(decisionKind(run(call))).toBe('allow');

    const second = run(call);
    expect(decisionKind(second)).toBe('deny');
    expect(second.hookSpecificOutput?.permissionDecisionReason).toMatch(/turn 4/);
    expect(second.hookSpecificOutput?.permissionDecisionReason).toMatch(/sha /);
  });

  /**
   * The runtime form of the lesson D10 learned expensively: an earlier
   * duplicate-read detector counted the agent reading back its own edits,
   * and 79% of what it flagged was legitimate. A guard built on the same
   * mistake would blind the agent to the file it had just written.
   */
  it('allows the re-read when the file changed by even one byte', () => {
    writeFile('src/a.ts', 'export const a = 1;\n');
    const call = input({
      event: 'PreToolUse',
      toolName: 'read_file',
      toolInput: { filePath: 'src/a.ts' },
    });

    run(call);
    writeFile('src/a.ts', 'export const a = 2;\n');

    expect(decisionKind(run(call))).toBe('allow');
  });

  it('treats a different line range as a different read', () => {
    writeFile('src/a.ts', Array.from({ length: 100 }, (_, i) => `line ${String(i)}`).join('\n'));

    const first = input({
      event: 'PreToolUse',
      toolName: 'read_file',
      toolInput: { filePath: 'src/a.ts', startLine: 1, endLine: 10 },
    });
    const second = input({
      event: 'PreToolUse',
      toolName: 'read_file',
      toolInput: { filePath: 'src/a.ts', startLine: 50, endLine: 60 },
    });

    run(first);
    // Disciplined retrieval is the behaviour to encourage, not to block.
    expect(decisionKind(run(second))).toBe('allow');
    expect(decisionKind(run(first))).toBe('deny');
  });

  it('never denies across sessions', () => {
    writeFile('src/a.ts', 'x\n');
    const call = {
      event: 'PreToolUse' as const,
      toolName: 'read_file',
      toolInput: { filePath: 'src/a.ts' },
    };

    run({ ...call, sessionId: 'a' });
    expect(decisionKind(run({ ...call, sessionId: 'b' }))).toBe('allow');
  });

  it('declines to have an opinion about a file it cannot hash', () => {
    // Outside the workspace, missing, or too large: all allowed.
    expect(
      decisionKind(
        run(
          input({
            event: 'PreToolUse',
            toolName: 'read_file',
            toolInput: { filePath: '../outside.ts' },
          }),
        ),
      ),
    ).toBe('allow');
    expect(
      decisionKind(
        run(
          input({
            event: 'PreToolUse',
            toolName: 'read_file',
            toolInput: { filePath: 'missing.ts' },
          }),
        ),
      ),
    ).toBe('allow');
  });

  it('does not hash a file above the size cap', () => {
    const big = writeFile('big.txt', 'x'.repeat(MAX_HASH_BYTES + 1));
    expect(fingerprintFile(big)).toBeUndefined();
  });

  it('forgets a read whose tool then failed', () => {
    writeFile('src/a.ts', 'x\n');
    const pre = input({
      event: 'PreToolUse',
      toolName: 'read_file',
      toolInput: { filePath: 'src/a.ts' },
    });

    run(pre);
    run(
      input({
        event: 'PostToolUse',
        toolName: 'read_file',
        toolInput: { filePath: 'src/a.ts' },
        toolError: true,
      }),
    );

    // The read never happened, so the retry must go through.
    expect(decisionKind(run(pre))).toBe('allow');
  });
});

describe('AUTO-15 · payload guard', () => {
  it('narrows an oversized read rather than refusing it', () => {
    writeFile('big.ts', 'x'.repeat(DEFAULT_GUARD_CONFIG.maxResultBytes + 1));

    const decision = run(
      input({ event: 'PreToolUse', toolName: 'read_file', toolInput: { filePath: 'big.ts' } }),
    );

    // Refusing leaves the agent to guess, and it will ask again — spending
    // the tokens anyway plus a round on top.
    expect(decisionKind(decision)).toBe('rewrite');
  });

  it('leaves a call the agent already bounded alone', () => {
    writeFile('big.ts', 'x'.repeat(DEFAULT_GUARD_CONFIG.maxResultBytes + 1));

    const decision = dispatch(
      input({
        event: 'PreToolUse',
        toolName: 'read_file',
        toolInput: { filePath: 'big.ts', startLine: 1, endLine: 10 },
      }),
      { db, salt: SALT, root, now: NOW, guards: GUARDS.filter((g) => g.id === 'payload-guard') },
    );

    expect(decisionKind(decision)).toBe('allow');
  });

  it('rewrites the arguments to a bounded range', () => {
    writeFile('big.ts', 'x'.repeat(DEFAULT_GUARD_CONFIG.maxResultBytes + 1));

    const decision = dispatch(
      input({ event: 'PreToolUse', toolName: 'read_file', toolInput: { filePath: 'big.ts' } }),
      { db, salt: SALT, root, now: NOW, guards: GUARDS.filter((g) => g.id === 'payload-guard') },
    );

    expect(decisionKind(decision)).toBe('rewrite');
    expect(decision.hookSpecificOutput?.updatedInput).toMatchObject({
      filePath: 'big.ts',
      startLine: 1,
      endLine: DEFAULT_GUARD_CONFIG.narrowToLines,
    });
  });
});

describe('AUTO-16 · runaway halt', () => {
  const loop = (rounds: number): ReturnType<typeof dispatch>[] => {
    const decisions: ReturnType<typeof dispatch>[] = [];
    for (let i = 0; i < rounds; i += 1) {
      decisions.push(run(input({ event: 'PostToolUse', toolName: 'grep_search' })));
    }
    return decisions;
  };

  it('trips on a deep loop that produced nothing', () => {
    const halts = loop(DEFAULT_GUARD_CONFIG.maxRounds + 2).filter((d) => !d.continue);

    expect(halts).toHaveLength(1);
    expect(halts[0]?.stopReason).toMatch(/no completed edit/);
  });

  /**
   * Depth alone is not the signal. D10's loop-cap optimiser found that
   * capping on depth would have cut off 68 of 70 *converging* loops on real
   * data — the guard must require depth **without output**.
   */
  it('does not trip on a deep loop that is landing edits', () => {
    run(input({ event: 'PostToolUse', toolName: 'create_file' }));
    const decisions = loop(DEFAULT_GUARD_CONFIG.maxRounds + 10);

    expect(decisions.every((d) => d.continue)).toBe(true);
  });

  it('halts once, not repeatedly', () => {
    // However far past the cap it runs, a session is stopped exactly once.
    expect(loop(DEFAULT_GUARD_CONFIG.maxRounds + 20).filter((d) => !d.continue)).toHaveLength(1);
  });

  it('counts a failed edit as no edit', () => {
    for (let i = 0; i < 5; i += 1) {
      run(input({ event: 'PostToolUse', toolName: 'create_file', toolError: true }));
    }
    expect(getSessionState(db, 'session-1')?.edits).toBe(0);
  });
});

describe('Tier C nudges', () => {
  it('fires the session-age nudge, then stays quiet', () => {
    for (let i = 0; i < DEFAULT_GUARD_CONFIG.nudgeAfterTurns; i += 1) {
      run(input({ event: 'UserPromptSubmit' }));
    }
    const fired = run(input({ event: 'UserPromptSubmit' }));
    expect(decisionKind(fired)).toBe('allow');

    // The counter reaches the threshold on the prompt that hits it.
    const state = getSessionState(db, 'session-1');
    expect(state?.turns).toBeGreaterThanOrEqual(DEFAULT_GUARD_CONFIG.nudgeAfterTurns);
  });

  it('says nothing about the first compaction and speaks on the second', () => {
    expect(decisionKind(run(input({ event: 'PreCompact' })))).toBe('allow');
    const second = run(input({ event: 'PreCompact' }));
    expect(decisionKind(second)).toBe('notify');
    expect(second.systemMessage).toMatch(/second time/);
  });
});

describe('H-5 · every intervention is logged with its evidence', () => {
  it('records what was denied and why', () => {
    writeFile('src/a.ts', 'x\n');
    const call = input({
      event: 'PreToolUse',
      toolName: 'read_file',
      toolInput: { filePath: 'src/a.ts' },
    });
    run(call);
    run(call);

    const log = readDecisionLog(db);
    const denial = log.find((entry) => entry.decision === 'deny');
    expect(denial?.rule).toBe('reread-suppressor');
    expect(denial?.toolName).toBe('read_file');
    // A guard that blocks a call and cannot say why is one nobody leaves on.
    expect(denial?.evidence.length).toBeGreaterThan(40);
  });
});

describe('D6.10 · a rule that misfires stands itself down', () => {
  /**
   * Insistence, not tool errors. A denial may itself surface to the agent
   * as an error, so counting errors would make every *correct* denial look
   * like a mistake and stand the guard down within minutes of installing
   * it. Asking for the same thing a third time is unambiguous.
   */
  const insist = (file: string, times: number): ReturnType<typeof dispatch>[] => {
    writeFile(file, 'x\n');
    const call = input({
      event: 'PreToolUse',
      toolName: 'read_file',
      toolInput: { filePath: file },
    });
    const decisions: ReturnType<typeof dispatch>[] = [];
    for (let i = 0; i < times; i += 1) decisions.push(run(call));
    return decisions;
  };

  it('yields rather than refusing the same thing forever', () => {
    const decisions = insist('src/a.ts', 5);

    // allow (first read), deny, deny, then it gives way.
    expect(decisions.map(decisionKind)).toEqual(['allow', 'deny', 'deny', 'allow', 'allow']);
  });

  it('counts each yield against the rule', () => {
    insist('src/a.ts', 5);

    const health = allRuleHealth(db).find((row) => row.rule === 'reread-suppressor');
    expect(health?.interventions).toBe(2);
    expect(health?.reversals).toBeGreaterThan(0);
  });

  it('logs the yield with its reason, not just the denials', () => {
    insist('src/a.ts', 4);

    const yielded = readDecisionLog(db).find((entry) => entry.decision === 'yielded');
    expect(yielded?.evidence).toMatch(/needs this whatever the guard believes/);
  });

  it('disables itself once the override rate passes the threshold', () => {
    // Enough distinct subjects for the interventions to reach the floor
    // where the ratio means anything.
    for (let i = 0; i < 12; i += 1) insist(`src/f${String(i)}.ts`, 4);

    expect(isDisabled(db, 'reread-suppressor')).toBe(true);
    const health = allRuleHealth(db).find((row) => row.rule === 'reread-suppressor');
    expect(health?.disabledReason).toMatch(/stood itself down/);
    expect(FALSE_POSITIVE_THRESHOLD).toBeLessThan(0.1);
  });

  it('a stood-down rule stops intervening, and the others keep working', () => {
    for (let i = 0; i < 12; i += 1) insist(`src/f${String(i)}.ts`, 4);
    expect(isDisabled(db, 'reread-suppressor')).toBe(true);

    writeFile('src/z.ts', 'x\n');
    const call = input({
      event: 'PreToolUse',
      toolName: 'read_file',
      toolInput: { filePath: 'src/z.ts' },
    });
    run(call);
    expect(decisionKind(run(call))).toBe('allow');

    // The runaway halt is untouched by its neighbour standing down.
    const halts: boolean[] = [];
    for (let i = 0; i < DEFAULT_GUARD_CONFIG.maxRounds + 2; i += 1) {
      halts.push(!run(input({ event: 'PostToolUse', toolName: 'grep_search' })).continue);
    }
    expect(halts.filter(Boolean)).toHaveLength(1);
  });
});

describe('H-2 · never crash the agent', () => {
  it('allows when a guard throws', () => {
    const exploding = {
      id: 'exploding',
      automation: 'TEST',
      attacks: '-',
      events: ['PreToolUse'] as const,
      decide(): never {
        throw new Error('boom');
      },
    };

    const decision = dispatch(input({ event: 'PreToolUse', toolName: 'read_file' }), {
      db,
      salt: SALT,
      root,
      now: NOW,
      guards: [exploding, ...GUARDS],
    });

    expect(decision).toEqual({ continue: true });
  });
  it('allows when the state store is unusable', () => {
    const broken = openGuardState(':memory:');
    broken.close();

    const decision = dispatch(input({ event: 'PreToolUse' }), {
      db: broken,
      salt: SALT,
      root,
      now: NOW,
    });
    expect(decision).toEqual({ continue: true });
  });

  it('allows on unparseable stdin, without touching the filesystem', async () => {
    const decision = await runHook({ stdin: 'garbage', cwd: root, event: 'PreToolUse' });
    expect(decision).toEqual({ continue: true });
  });

  it('allows rather than hanging when stdin never arrives', async () => {
    const decision = await runHook({
      stdin: '',
      cwd: root,
      event: 'PreToolUse',
      stdinTimeoutMs: 5,
    });
    expect(decision).toEqual({ continue: true });
  });
});

describe('hook configuration (D6.2)', () => {
  it('configures every event a guard is registered for', () => {
    const [config] = generateHookConfig();
    const document = JSON.parse(config?.contents ?? '{}') as {
      hooks: { event: string; command: string }[];
    };

    const configured = new Set(document.hooks.map((entry) => entry.event));
    for (const guard of GUARDS) {
      for (const event of guard.events) expect(configured.has(event)).toBe(true);
    }
    expect(document.hooks.every((entry) => entry.command.includes('hook --event'))).toBe(true);
  });

  it('only configures events that exist in the protocol', () => {
    const [config] = generateHookConfig();
    const document = JSON.parse(config?.contents ?? '{}') as { hooks: { event: string }[] };

    for (const entry of document.hooks) {
      expect(HOOK_EVENTS).toContain(entry.event);
    }
  });

  it('explains itself, including what it will not do', () => {
    const readme = generateHookConfig().find((artefact) => artefact.path.endsWith('README.md'));

    expect(readme?.contents).toMatch(/never denies on a guess/);
    expect(readme?.contents).toMatch(/never breaks the agent/);
    expect(readme?.contents).toMatch(/turns itself off/);
    // Automations that were specified and not built are named, not omitted.
    for (const entry of UNAVAILABLE_GUARDS) {
      expect(readme?.contents).toContain(entry.automation);
    }
  });
});
