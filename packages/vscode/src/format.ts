/** Shared numeric formatting for the status bar, sidebar and chart presenter. */
export function credits(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
}
