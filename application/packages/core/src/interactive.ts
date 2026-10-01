import { z } from "zod";
const key = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
export const interactiveDraftSchema = z
  .object({
    kind: z.literal("interactive"),
    layout: z.enum(["table", "form", "report"]),
    description: z.string().max(30000),
    columns: z
      .array(
        z
          .object({
            id: key,
            title: z.string().trim().min(1).max(100),
            type: z.enum(["text", "number", "boolean"]),
            required: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(24),
    rows: z
      .array(
        z
          .object({
            id: key,
            cells: z.record(
              key,
              z.union([
                z.string().max(4000),
                z.number(),
                z.boolean(),
                z.null(),
              ]),
            ),
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();
export const interactiveSchema = interactiveDraftSchema.superRefine(
  (value, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    if (new Set(value.columns.map((c) => c.id)).size !== value.columns.length)
      fail("字段标识不能重复。");
    if (new Set(value.rows.map((r) => r.id)).size !== value.rows.length)
      fail("记录标识不能重复。");
    const columns = new Map(value.columns.map((c) => [c.id, c]));
    for (const row of value.rows) {
      for (const id of Object.keys(row.cells))
        if (!columns.has(id)) fail("记录含未定义字段。");
      for (const c of value.columns) {
        const cell = row.cells[c.id];
        if (cell === null || cell === undefined || cell === "") {
          if (c.required) fail(`「${c.title}」不能为空。`);
          continue;
        }
        if (typeof cell !== (c.type === "text" ? "string" : c.type))
          fail(`「${c.title}」的数据类型不符。`);
      }
    }
    if (JSON.stringify(value).length > 1000000) fail("交互对象超过容量限制。");
  },
);
export type InteractiveContent = z.infer<typeof interactiveSchema>;
export const interactiveRowSchema = interactiveDraftSchema.shape.rows.element;
export const interactiveSortSchema = z
  .object({ columnId: key, descending: z.boolean() })
  .strict();
export const interactiveRowsQuerySchema = z
  .object({
    revision: z.number().int().positive().optional(),
    query: z.string().trim().max(500).optional(),
    sort: interactiveSortSchema.optional(),
    after: z.string().min(1).max(8192).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();
export const interactiveRowOperationSchema = z
  .discriminatedUnion("type", [
    z
      .object({
        type: z.literal("insert"),
        row: interactiveRowSchema,
        beforeRowId: key.optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("update"),
        rowId: key,
        cells: interactiveRowSchema.shape.cells,
        unset: z.array(key).max(24).optional(),
      })
      .strict(),
    z.object({ type: z.literal("delete"), rowId: key }).strict(),
    z
      .object({
        type: z.literal("restore"),
        rowId: key,
        fromRevision: z.number().int().positive(),
        beforeRowId: key.optional(),
      })
      .strict(),
  ])
  .superRefine((operation, ctx) => {
    if (operation.type !== "update") return;
    const unset = operation.unset ?? [];
    if (Object.keys(operation.cells).length + unset.length === 0)
      ctx.addIssue({ code: "custom", message: "请指定要修改的字段。" });
    if (new Set(unset).size !== unset.length)
      ctx.addIssue({ code: "custom", message: "移除的字段不能重复。" });
    if (unset.some((id) => Object.hasOwn(operation.cells, id)))
      ctx.addIssue({ code: "custom", message: "同一字段不能同时修改和移除。" });
  });
export const interactiveRowsPageSchema = z
  .object({
    objectId: z.string().min(1),
    contentId: z.string().min(1),
    revision: z.number().int().positive(),
    headRevision: z.number().int().positive(),
    title: z.string(),
    layout: interactiveDraftSchema.shape.layout,
    description: interactiveDraftSchema.shape.description,
    columns: interactiveDraftSchema.shape.columns,
    total: z.number().int().nonnegative(),
    matched: z.number().int().nonnegative(),
    rows: z.array(interactiveRowSchema).max(100),
    summaries: z.array(
      z
        .object({
          id: key,
          title: z.string(),
          count: z.number().int().nonnegative(),
          sum: z.number(),
          mean: z.number().nullable(),
        })
        .strict(),
    ),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type InteractiveRowsQuery = z.infer<typeof interactiveRowsQuerySchema>;
export type InteractiveRowOperation = z.infer<
  typeof interactiveRowOperationSchema
>;
export type InteractiveRowsPage = z.infer<typeof interactiveRowsPageSchema>;
/** Preserve the existing editor contract while sending ordinary row edits as
 * local domain changes. Column/view/order changes use the explicit full-revise
 * contract; this function never invents a baseline or drops requested edits. */
export function interactiveRowEdits(
  previous: InteractiveContent,
  next: InteractiveContent,
): InteractiveRowOperation[] | null {
  if (
    previous.layout !== next.layout ||
    previous.description !== next.description ||
    JSON.stringify(previous.columns) !== JSON.stringify(next.columns)
  )
    return null;
  const oldRows = new Map(previous.rows.map((row) => [row.id, row]));
  const newRows = new Map(next.rows.map((row) => [row.id, row]));
  if (
    oldRows.size !== previous.rows.length ||
    newRows.size !== next.rows.length
  )
    return null;
  const survivingOldIds = previous.rows
    .filter((row) => newRows.has(row.id))
    .map((row) => row.id);
  const survivingNewIds = next.rows
    .filter((row) => oldRows.has(row.id))
    .map((row) => row.id);
  if (JSON.stringify(survivingOldIds) !== JSON.stringify(survivingNewIds))
    return null;
  const operations: InteractiveRowOperation[] = [];
  for (const row of previous.rows)
    if (!newRows.has(row.id))
      operations.push({ type: "delete", rowId: row.id });
  for (const row of next.rows) {
    const previousRow = oldRows.get(row.id);
    if (!previousRow) continue;
    const cells = Object.fromEntries(
      Object.entries(row.cells).filter(
        ([id, value]) =>
          !Object.hasOwn(previousRow.cells, id) ||
          previousRow.cells[id] !== value,
      ),
    );
    const unset = Object.keys(previousRow.cells).filter(
      (id) => !Object.hasOwn(row.cells, id),
    );
    if (Object.keys(cells).length || unset.length)
      operations.push({
        type: "update",
        rowId: row.id,
        cells,
        ...(unset.length ? { unset } : {}),
      });
  }
  // Reverse insertion guarantees that each beforeRowId already exists.
  for (let i = next.rows.length - 1; i >= 0; i--) {
    const row = next.rows[i]!;
    if (!oldRows.has(row.id))
      operations.push({
        type: "insert",
        row,
        ...(next.rows[i + 1] ? { beforeRowId: next.rows[i + 1]!.id } : {}),
      });
  }
  return operations.length <= 100 ? operations : null;
}
export function interactiveText(c: InteractiveContent) {
  return (
    c.description +
    "\n" +
    c.columns.map((c) => c.title).join(" | ") +
    "\n" +
    c.rows
      .map((r) => c.columns.map((c) => String(r.cells[c.id] ?? "")).join(" | "))
      .join("\n")
  );
}
export function interactiveSummary(c: InteractiveContent) {
  return c.columns
    .filter((c) => c.type === "number")
    .map((column) => {
      const values = c.rows
        .map((r) => r.cells[column.id])
        .filter((v): v is number => typeof v === "number");
      const sum = values.reduce((a, b) => a + b, 0);
      return {
        id: column.id,
        title: column.title,
        count: values.length,
        sum,
        mean: values.length ? sum / values.length : null,
      };
    });
}
export const emptyInteractive: InteractiveContent = {
  kind: "interactive",
  layout: "table",
  description: "",
  columns: [
    { id: "name", title: "名称", type: "text", required: true },
    { id: "value", title: "数值", type: "number", required: false },
    { id: "done", title: "完成", type: "boolean", required: false },
  ],
  rows: [],
};
