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
