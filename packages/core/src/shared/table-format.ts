/**
 * Pure table layout — computes the header, separator, and row strings for
 * a simple two-space-gutter table, with no opinion about where the
 * result goes. Shared by `shared/logger.ts` (stderr) and
 * `cli/output.ts` (stdout) so the two output paths format tables
 * identically without duplicating the padding/alignment logic.
 */
export interface FormattedTable {
  readonly header: string;
  readonly separator: string;
  readonly rows: readonly string[];
}

export function formatTable(
  data: readonly Record<string, string | number>[],
): FormattedTable | undefined {
  const [firstRow] = data;
  if (!firstRow) return undefined;

  const keys = Object.keys(firstRow);
  const widths = keys.map((key) =>
    Math.max(key.length, ...data.map((row) => String(row[key] ?? '').length)),
  );

  const header = keys.map((key, i) => key.padEnd(widths[i] ?? key.length)).join('  ');
  const rows = data.map((row) =>
    keys.map((key, i) => String(row[key] ?? '').padEnd(widths[i] ?? 0)).join('  '),
  );

  return { header, separator: '─'.repeat(header.length), rows };
}
