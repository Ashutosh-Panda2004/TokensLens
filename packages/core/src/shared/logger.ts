import { ansi, isColorSupported } from './ansi.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

const KNOWN_LEVELS: ReadonlySet<string> = new Set<LogLevel>([
  'debug',
  'info',
  'warn',
  'error',
  'silent',
]);

function isLogLevel(value: string): value is LogLevel {
  return KNOWN_LEVELS.has(value);
}

function resolveDefaultLevel(): LogLevel {
  const fromEnv = process.env.TOKENLENS_LOG_LEVEL;
  return fromEnv && isLogLevel(fromEnv) ? fromEnv : 'info';
}

export interface Logger {
  readonly level: LogLevel;
  debug(message: string, ...args: readonly unknown[]): void;
  info(message: string, ...args: readonly unknown[]): void;
  success(message: string, ...args: readonly unknown[]): void;
  warn(message: string, ...args: readonly unknown[]): void;
  error(message: string, ...args: readonly unknown[]): void;
  heading(message: string): void;
  table(rows: readonly Record<string, string | number>[]): void;
  /** Returns a logger that prefixes every message with `[scope]`. */
  child(scope: string): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Injected for testability and redirection. Defaults to `process.stderr`. */
  sink?: (line: string) => void;
  /** Force colour on/off, overriding TTY/NO_COLOR auto-detection. */
  color?: boolean;
  scope?: string;
}

function formatArgs(message: string, args: readonly unknown[]): string {
  if (args.length === 0) return message;
  const rendered = args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)));
  return `${message} ${rendered.join(' ')}`;
}

/**
 * Creates a logger.
 *
 * **Every log line goes to stderr, never stdout** — unconditionally, by
 * design. `tokenlens hook` writes exactly one JSON decision to stdout for
 * the Copilot agent to parse (Phase D6); a stray log line on stdout would
 * corrupt that contract. Fixing the stream here, once, means every future
 * command inherits the guarantee instead of having to remember it.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? resolveDefaultLevel();
  const sink = options.sink ?? ((line: string): void => void process.stderr.write(`${line}\n`));
  const colorEnabled = options.color ?? isColorSupported(process.stderr);
  const prefix = options.scope ? `[${options.scope}] ` : '';

  const paint = (fn: (text: string) => string, text: string): string =>
    colorEnabled ? fn(text) : text;

  function emit(minLevel: LogLevel, line: string): void {
    if (LEVEL_RANK[level] > LEVEL_RANK[minLevel]) return;
    sink(line);
  }

  return {
    level,

    debug(message, ...args): void {
      emit('debug', paint(ansi.gray, `${prefix}[debug] ${formatArgs(message, args)}`));
    },

    info(message, ...args): void {
      emit('info', `${paint(ansi.blue, 'ℹ')} ${prefix}${formatArgs(message, args)}`);
    },

    success(message, ...args): void {
      emit('info', `${paint(ansi.green, '✓')} ${prefix}${formatArgs(message, args)}`);
    },

    warn(message, ...args): void {
      emit('warn', paint(ansi.yellow, `⚠ ${prefix}${formatArgs(message, args)}`));
    },

    error(message, ...args): void {
      emit('error', paint(ansi.red, `✗ ${prefix}${formatArgs(message, args)}`));
    },

    heading(message): void {
      const text = `${prefix}${message}`;
      emit('info', paint(ansi.boldCyan, `\n${text}`));
      emit('info', paint(ansi.cyan, '─'.repeat(text.length)));
    },

    table(rows): void {
      const [firstRow] = rows;
      if (!firstRow) return;

      const keys = Object.keys(firstRow);
      const widths = keys.map((key) =>
        Math.max(key.length, ...rows.map((row) => String(row[key] ?? '').length)),
      );

      const header = keys.map((key, i) => key.padEnd(widths[i] ?? key.length)).join('  ');
      emit('info', paint(ansi.bold, header));
      emit('info', paint(ansi.gray, '─'.repeat(header.length)));
      for (const row of rows) {
        emit(
          'info',
          keys.map((key, i) => String(row[key] ?? '').padEnd(widths[i] ?? 0)).join('  '),
        );
      }
    },

    child(scope): Logger {
      return createLogger({
        level,
        sink,
        color: colorEnabled,
        scope: options.scope ? `${options.scope}:${scope}` : scope,
      });
    },
  };
}

/**
 * Default, process-wide logger. Prefer this; use `createLogger` / `child()`
 * only when you need an isolated instance (tests, a scoped module).
 */
export const logger: Logger = createLogger();
