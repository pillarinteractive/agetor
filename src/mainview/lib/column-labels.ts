import type { ColumnId } from "../../shared/types.ts";

/** What the board calls each column. Display only: column ids, and the
 *  labels the server and the CLI use (`COLUMNS` in src/shared/types.ts),
 *  are unchanged. */
const COLUMN_LABELS: Record<ColumnId, string> = {
  backlog: "Backlog",
  ready: "Ready",
  running: "Running",
  blocked: "Blocked",
  review: "In review",
  merge: "Merge queue",
  done: "Done",
};

export const columnLabel = (id: ColumnId): string => COLUMN_LABELS[id];
