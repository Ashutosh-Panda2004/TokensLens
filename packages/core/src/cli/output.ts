import { ansi, isColorSupported } from '../shared/ansi.js';
import { formatTable } from '../shared/table-format.js';

/**
 * Prints command **report output** — the actual answer the user ran the
 * command for (tables, JSON, figures) — deliberately to stdout, never
 * through `shared/logger.ts` (which is stderr-only by design; see that
 * module's doc comment). Progress/diagnostic messages during a command
 * still belong on `logger`; this module is only for the payload.
 */

const colorEnabled = isColorSupported(process.stdout);

function paint(fn: (text: string) => string, text: string): string {
  return colorEnabled ? fn(text) : text;
}

export function printLine(text = ''): void {
  process.stdout.write(`${text}\n`);
}

export function printHeading(text: string): void {
  printLine();
  printLine(paint(ansi.boldCyan, text));
  printLine(paint(ansi.cyan, '─'.repeat(text.length)));
}

export function printTable(rows: readonly Record<string, string | number>[]): void {
  const formatted = formatTable(rows);
  if (!formatted) return;

  printLine(paint(ansi.bold, formatted.header));
  printLine(paint(ansi.gray, formatted.separator));
  for (const row of formatted.rows) printLine(row);
}

export function printJson(value: unknown): void {
  printLine(JSON.stringify(value, null, 2));
}
