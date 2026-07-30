/**
 * Minimal, hand-rolled ANSI styling.
 *
 * Deliberately not a dependency such as chalk: chalk 5 ships ESM-only with
 * no CommonJS entry point, which would reintroduce exactly the dual-format
 * packaging hazard this project's build is designed to avoid (see
 * `tsup.config.ts`). The styling surface needed here — five colours and
 * bold — is not worth a dependency, a lockfile entry, or a supply-chain
 * review line.
 *
 * Colour is expected to be disabled automatically by the caller (see
 * `logger.ts`) when the target stream is not a TTY, or when `NO_COLOR` /
 * `TOKENLENS_NO_COLOR` is set (https://no-color.org/), and forced on via
 * `FORCE_COLOR`.
 */

const SGR = {
  reset: 0,
  bold: 1,
  gray: 90,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  cyan: 36,
} as const;

function paint(code: number | string, text: string): string {
  return `\u001b[${String(code)}m${text}\u001b[${String(SGR.reset)}m`;
}

/**
 * Whether ANSI colour should be used for the given stream, honouring the
 * `NO_COLOR`, `TOKENLENS_NO_COLOR`, and `FORCE_COLOR` environment variables
 * before falling back to TTY detection.
 */
export function isColorSupported(
  stream: Pick<NodeJS.WriteStream, 'isTTY'> = process.stderr,
): boolean {
  if (process.env.NO_COLOR !== undefined || process.env.TOKENLENS_NO_COLOR !== undefined) {
    return false;
  }
  if (process.env.FORCE_COLOR !== undefined) return true;
  return stream.isTTY;
}

export const ansi = {
  bold: (text: string): string => paint(SGR.bold, text),
  gray: (text: string): string => paint(SGR.gray, text),
  red: (text: string): string => paint(SGR.red, text),
  green: (text: string): string => paint(SGR.green, text),
  yellow: (text: string): string => paint(SGR.yellow, text),
  blue: (text: string): string => paint(SGR.blue, text),
  cyan: (text: string): string => paint(SGR.cyan, text),
  boldCyan: (text: string): string => paint(`${String(SGR.bold)};${String(SGR.cyan)}`, text),
};

// The control character is deliberate and necessary: this is the ANSI
// escape byte itself, not an accidental/obfuscated one.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;]*m/g;

/** Removes ANSI SGR escape sequences from `text`. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, '');
}
