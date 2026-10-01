import type { InteractiveContent } from "../../core/src/interactive.js";

export type InteractiveRow = InteractiveContent["rows"][number];
export type InteractiveSort = { columnId: string; descending: boolean };
export type InteractiveRowsRequest = {
  credential: string;
  objectId: string;
  revision?: number;
  query?: string;
  sort?: InteractiveSort;
  /** Opaque cursor fixes the object version, filter and ordering. */
  after?: string;
  /** Bounded direct row location for existing read(table); exclusive of after. */
  offset?: number;
  limit?: number;
};
export type InteractiveRowsPage = {
  objectId: string;
  contentId: string;
  revision: number;
  headRevision: number;
  title: string;
  layout: InteractiveContent["layout"];
  description: string;
  columns: InteractiveContent["columns"];
  total: number;
  matched: number;
  rows: InteractiveRow[];
  /** Entire exact-version matching set, not just this page. */
  summaries: {
    id: string;
    title: string;
    count: number;
    sum: number;
    mean: number | null;
  }[];
  nextCursor: string | null;
};
export type InteractiveRowOperation =
  | { type: "insert"; row: InteractiveRow; beforeRowId?: string }
  | {
      type: "update";
      rowId: string;
      cells: InteractiveRow["cells"];
      /** Removing a key differs from storing null or an empty string. */
      unset?: string[];
    }
  | { type: "delete"; rowId: string }
  | {
      type: "restore";
      rowId: string;
      fromRevision: number;
      beforeRowId?: string;
    };
export type InteractiveRowsPatch = {
  credential: string;
  commandId: string;
  objectId: string;
  expectedRevision: number;
  operations: InteractiveRowOperation[];
};
