/**
 * Helpers for workspace commands whose server output is only meant
 * for humans.
 */

export interface WorkspaceListing {
  name: string;
  /** e.g. `untyped`, `assets_v1`. */
  type: string;
  /** Human-readable, e.g. `44 MB`. */
  size: string;
  /** Human-readable, e.g. `5h ago`. */
  modified: string;
}

// oxlint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

const COLUMNS = ["name", "type", "size", "modified"] as const;

/**
 * Parse `workspace list` output. The server prints a fixed-width table
 * (there is no machine-readable form), so columns are sliced at the
 * header's offsets.
 */
export function parseWorkspaceList(text: string): WorkspaceListing[] {
  const lines = stripAnsi(text).split("\n");
  const headerIndex = lines.findIndex((line) => /^\s*name\s+type\s+size\s+modified\s*$/.test(line));
  if (headerIndex < 0) throw new Error("Unrecognized workspace list output.");
  const header = lines[headerIndex]!;
  const starts = COLUMNS.map((column) => header.indexOf(column));

  const out: WorkspaceListing[] = [];
  for (const line of lines.slice(headerIndex + 1)) {
    if (!line.trim()) continue;
    const cell = (i: number) =>
      line.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : undefined).trim();
    const listing = { name: cell(0), type: cell(1), size: cell(2), modified: cell(3) };
    if (listing.name) out.push(listing);
  }
  return out;
}
