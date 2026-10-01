import { createHash } from "node:crypto";
import { z } from "zod";
import { DomainError } from "../../core/src/model.js";
import {
  interactiveSchema,
  type InteractiveContent,
} from "../../core/src/interactive.js";
import {
  safeInteger,
  type SqlQuery,
  type SqlScalar,
} from "../../storage/src/sql.js";
import type {
  InteractiveRow,
  InteractiveRowsPatch,
  InteractiveSort,
} from "./interactive-types.js";

const sha = (body: string) => createHash("sha256").update(body).digest("hex");
const pointerSchema = z
  .object({
    kind: z.literal("interactive"),
    storage: z.literal("relational-v1"),
    tableRevision: z.number().int().positive(),
    snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type InteractivePointer = z.infer<typeof pointerSchema>;
export function interactivePointer(body: string): InteractivePointer {
  const parsed = pointerSchema.safeParse(JSON.parse(body));
  if (!parsed.success) throw new Error("表格持久版本指针无效。");
  return parsed.data;
}
type Reference = {
  id: string;
  revision: number;
  sha256: string;
  units: number;
  ordinal: number;
};
export type InteractiveRoot = {
  pointer: InteractivePointer;
  schemaRevision: number;
  layout: InteractiveContent["layout"];
  description: string;
  columns: InteractiveContent["columns"];
  references: Reference[];
  units: number;
};
function rowBody(row: InteractiveRow) {
  return JSON.stringify({
    id: row.id,
    cells: Object.fromEntries(
      Object.entries(row.cells).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      ),
    ),
  });
}
function snapshotHash(
  root: Pick<
    InteractiveRoot,
    "schemaRevision" | "layout" | "description" | "columns" | "references"
  >,
) {
  return sha(
    JSON.stringify({
      schemaRevision: root.schemaRevision,
      layout: root.layout,
      description: root.description,
      columnsSha256: sha(JSON.stringify(root.columns)),
      rows: root.references.map((r) => [
        r.id,
        r.revision,
        r.sha256,
        r.units,
        r.ordinal,
      ]),
    }),
  );
}
function contentUnits(
  root: Pick<
    InteractiveRoot,
    "layout" | "description" | "columns" | "references"
  >,
) {
  const header = JSON.stringify({
    kind: "interactive",
    layout: root.layout,
    description: root.description,
    columns: root.columns,
    rows: [],
  }).length;
  return (
    header +
    root.references.reduce((sum, row) => sum + row.units, 0) +
    Math.max(0, root.references.length - 1)
  );
}
async function batchInsert(
  q: SqlQuery,
  table: string,
  columns: string[],
  rows: SqlScalar[][],
) {
  // Fixed identifiers are supplied only by this module. Batches stay below
  // SQLite/PG bind limits and avoid one round-trip per record.
  for (let offset = 0; offset < rows.length; offset += 100) {
    const batch = rows.slice(offset, offset + 100);
    await q.change(
      `INSERT INTO ${table}(${columns.join(",")}) VALUES ${batch.map(() => `(${columns.map(() => "?").join(",")})`).join(",")}`,
      batch.flat(),
    );
  }
}
export async function readInteractiveRoot(
  q: SqlQuery,
  tenantId: string,
  objectId: string,
  pointer: InteractivePointer,
): Promise<InteractiveRoot> {
  const row = (
    await q.all<{
      object_revision: number | string;
      schema_revision: number | string;
      layout: string;
      description: string;
      row_count: number | string;
      serialized_units: number | string;
      columns_sha256: string;
      snapshot_sha256: string;
    }>(
      "SELECT * FROM interactive_versions WHERE tenant_id=? AND object_id=? AND object_revision=?",
      [tenantId, objectId, pointer.tableRevision],
    )
  )[0];
  if (
    !row ||
    safeInteger(row.object_revision, "表格版本") !== pointer.tableRevision ||
    row.snapshot_sha256 !== pointer.snapshotSha256
  )
    throw new Error("表格精确版本或根摘要不匹配。");
  const schemaRevision = safeInteger(row.schema_revision, "字段版本");
  if (schemaRevision > pointer.tableRevision)
    throw new Error("表格字段版本来自未来。");
  const fields = await q.all<{
    column_id: string;
    ordinal: number | string;
    title: string;
    value_type: string;
    required: number | string;
  }>(
    "SELECT column_id,ordinal,title,value_type,required FROM interactive_columns WHERE tenant_id=? AND object_id=? AND schema_revision=? ORDER BY ordinal",
    [tenantId, objectId, schemaRevision],
  );
  if (
    fields.some(
      (field, index) => safeInteger(field.ordinal, "字段次序") !== index,
    )
  )
    throw new Error("表格字段次序不完整。");
  const parsedColumns = interactiveSchema.shape.columns.safeParse(
    fields.map((field) => ({
      id: field.column_id,
      title: field.title,
      type: field.value_type,
      required: safeInteger(field.required, "必填状态") === 1,
    })),
  );
  if (!parsedColumns.success) throw new Error("表格持久字段定义无效。");
  const columns = parsedColumns.data;
  if (sha(JSON.stringify(columns)) !== row.columns_sha256)
    throw new Error("表格字段摘要不匹配。");
  const entries = await q.all<{
    row_id: string;
    row_revision: number | string;
    ordinal: number | string;
    cells_sha256: string;
    serialized_units: number | string;
  }>(
    `SELECT m.row_id,m.row_revision,m.ordinal,r.cells_sha256,r.serialized_units FROM interactive_version_rows m JOIN interactive_row_versions r ON r.tenant_id=m.tenant_id AND r.object_id=m.object_id AND r.row_id=m.row_id AND r.row_revision=m.row_revision WHERE m.tenant_id=? AND m.object_id=? AND m.object_revision=? ORDER BY m.ordinal`,
    [tenantId, objectId, pointer.tableRevision],
  );
  const references = entries.map((entry) => ({
    id: entry.row_id,
    revision: safeInteger(entry.row_revision, "行版本"),
    ordinal: safeInteger(entry.ordinal, "行次序"),
    sha256: entry.cells_sha256,
    units: safeInteger(entry.serialized_units, "行容量"),
  }));
  if (
    references.length !== safeInteger(row.row_count, "表格行数") ||
    references.some(
      (entry, index) =>
        entry.ordinal !== index || entry.revision > pointer.tableRevision,
    )
  )
    throw new Error("表格行清单不完整或指向未来版本。");
  const layout = interactiveSchema.shape.layout.safeParse(row.layout);
  const description = interactiveSchema.shape.description.safeParse(
    row.description,
  );
  if (!layout.success || !description.success)
    throw new Error("表格持久布局或说明无效。");
  const root: InteractiveRoot = {
    pointer,
    schemaRevision,
    layout: layout.data,
    description: description.data,
    columns,
    references,
    units: safeInteger(row.serialized_units, "表格容量"),
  };
  if (
    snapshotHash(root) !== pointer.snapshotSha256 ||
    contentUnits(root) !== root.units
  )
    throw new Error("表格版本清单摘要不匹配。");
  return root;
}
export async function readInteractiveRows(
  q: SqlQuery,
  tenantId: string,
  objectId: string,
  references: Reference[],
): Promise<InteractiveRow[]> {
  const rows: InteractiveRow[] = [];
  for (let offset = 0; offset < references.length; offset += 100) {
    const batch = references.slice(offset, offset + 100);
    // Each branch seeks the complete versioned key. An OR over row pairs can
    // make SQLite/PG scan every historical cell in this object once per batch;
    // tuple IN/VALUES joins also depend on backend statistics. A bounded
    // UNION ALL keeps exact-key reads on both backends without planner hints.
    const cells = await q.all<{
      row_id: string;
      row_revision: number | string;
      column_id: string;
      value_kind: string;
      text_value: string | null;
      number_value: number | string | null;
      boolean_value: number | string | null;
    }>(
      `${batch.map(() => "SELECT row_id,row_revision,column_id,value_kind,text_value,number_value,boolean_value FROM interactive_cells WHERE tenant_id=? AND object_id=? AND row_id=? AND row_revision=?").join(" UNION ALL ")} ORDER BY row_id,column_id`,
      batch.flatMap((row) => [tenantId, objectId, row.id, row.revision]),
    );
    const grouped = new Map(
      batch.map((row) => [
        `${row.id}:${row.revision}`,
        { id: row.id, cells: {} as InteractiveRow["cells"] },
      ]),
    );
    for (const cell of cells) {
      const row = grouped.get(
        `${cell.row_id}:${safeInteger(cell.row_revision, "行版本")}`,
      );
      if (!row) throw new Error("单元格行版本不匹配。");
      let value: InteractiveRow["cells"][string];
      if (cell.value_kind === "null") value = null;
      else if (cell.value_kind === "text" && cell.text_value !== null)
        value = cell.text_value;
      else if (
        cell.value_kind === "number" &&
        cell.number_value !== null &&
        Number.isFinite(Number(cell.number_value))
      )
        value = Number(cell.number_value);
      else if (
        cell.value_kind === "boolean" &&
        cell.boolean_value !== null &&
        (Number(cell.boolean_value) === 0 || Number(cell.boolean_value) === 1)
      )
        value = Number(cell.boolean_value) === 1;
      else throw new Error("表格单元格类型无效。");
      row.cells[cell.column_id] = value;
    }
    for (const reference of batch) {
      const row = grouped.get(`${reference.id}:${reference.revision}`)!;
      const body = rowBody(row);
      if (sha(body) !== reference.sha256 || body.length !== reference.units)
        throw new Error("表格行摘要不匹配。");
      rows.push(row);
    }
  }
  return rows;
}
export async function readInteractiveContent(
  q: SqlQuery,
  tenantId: string,
  objectId: string,
  body: string,
) {
  const root = await readInteractiveRoot(
    q,
    tenantId,
    objectId,
    interactivePointer(body),
  );
  const parsed = interactiveSchema.safeParse({
    kind: "interactive",
    layout: root.layout,
    description: root.description,
    columns: root.columns,
    rows: await readInteractiveRows(q, tenantId, objectId, root.references),
  });
  if (!parsed.success) throw new Error("表格持久版本字段或记录不一致。");
  return parsed.data;
}
async function persistRoot(
  q: SqlQuery,
  tenantId: string,
  objectId: string,
  revision: number,
  root: Omit<InteractiveRoot, "pointer" | "units">,
  changedRows: InteractiveRow[],
  newSchema: boolean,
) {
  const units = contentUnits(root);
  if (units > 1000000 || root.references.length > 1000)
    throw new DomainError("invalid", "交互对象超过容量限制。");
  if (newSchema)
    await batchInsert(
      q,
      "interactive_columns",
      [
        "tenant_id",
        "object_id",
        "schema_revision",
        "column_id",
        "ordinal",
        "title",
        "value_type",
        "required",
      ],
      root.columns.map((column, ordinal) => [
        tenantId,
        objectId,
        root.schemaRevision,
        column.id,
        ordinal,
        column.title,
        column.type,
        column.required ? 1 : 0,
      ]),
    );
  const references = new Map(root.references.map((row) => [row.id, row]));
  await batchInsert(
    q,
    "interactive_row_versions",
    [
      "tenant_id",
      "object_id",
      "row_id",
      "row_revision",
      "schema_revision",
      "cells_sha256",
      "serialized_units",
    ],
    changedRows.map((row) => [
      tenantId,
      objectId,
      row.id,
      revision,
      root.schemaRevision,
      references.get(row.id)!.sha256,
      references.get(row.id)!.units,
    ]),
  );
  await batchInsert(
    q,
    "interactive_cells",
    [
      "tenant_id",
      "object_id",
      "row_id",
      "row_revision",
      "column_id",
      "value_kind",
      "text_value",
      "number_value",
      "boolean_value",
      "search_fold",
    ],
    changedRows.flatMap((row) =>
      Object.entries(row.cells).map(([id, value]) => [
        tenantId,
        objectId,
        row.id,
        revision,
        id,
        value === null
          ? "null"
          : typeof value === "string"
            ? "text"
            : typeof value === "number"
              ? "number"
              : "boolean",
        typeof value === "string" ? value : null,
        typeof value === "number" ? value : null,
        typeof value === "boolean" ? (value ? 1 : 0) : null,
        String(value ?? "").toLocaleLowerCase(),
      ]),
    ),
  );
  const pointer: InteractivePointer = {
    kind: "interactive",
    storage: "relational-v1",
    tableRevision: revision,
    snapshotSha256: snapshotHash(root),
  };
  await batchInsert(
    q,
    "interactive_versions",
    [
      "tenant_id",
      "object_id",
      "object_revision",
      "schema_revision",
      "layout",
      "description",
      "row_count",
      "serialized_units",
      "columns_sha256",
      "snapshot_sha256",
    ],
    [
      [
        tenantId,
        objectId,
        revision,
        root.schemaRevision,
        root.layout,
        root.description,
        root.references.length,
        units,
        sha(JSON.stringify(root.columns)),
        pointer.snapshotSha256,
      ],
    ],
  );
  // This fixed-version manifest costs O(N) small references; it never copies
  // unchanged row/cell payloads and requires no delta replay to read history.
  await batchInsert(
    q,
    "interactive_version_rows",
    [
      "tenant_id",
      "object_id",
      "object_revision",
      "row_id",
      "row_revision",
      "ordinal",
    ],
    root.references.map((row) => [
      tenantId,
      objectId,
      revision,
      row.id,
      row.revision,
      row.ordinal,
    ]),
  );
  return JSON.stringify(pointer);
}
export async function writeInteractiveContent(
  q: SqlQuery,
  tenantId: string,
  objectId: string,
  revision: number,
  content: InteractiveContent,
  previousBody?: string,
) {
  const previous = previousBody
    ? await readInteractiveRoot(
        q,
        tenantId,
        objectId,
        interactivePointer(previousBody),
      )
    : null;
  const newSchema =
    !previous ||
    JSON.stringify(previous.columns) !== JSON.stringify(content.columns);
  const schemaRevision = newSchema ? revision : previous!.schemaRevision;
  const oldRows = new Map(previous?.references.map((row) => [row.id, row]));
  const changed: InteractiveRow[] = [];
  const references = content.rows.map((row, ordinal) => {
    const body = rowBody(row);
    const hash = sha(body);
    const old = oldRows.get(row.id);
    if (old?.sha256 === hash) return { ...old, ordinal };
    changed.push(row);
    return { id: row.id, revision, sha256: hash, units: body.length, ordinal };
  });
  return persistRoot(
    q,
    tenantId,
    objectId,
    revision,
    {
      schemaRevision,
      layout: content.layout,
      description: content.description,
      columns: content.columns,
      references,
    },
    changed,
    newSchema,
  );
}
export async function patchInteractiveContent(
  q: SqlQuery,
  tenantId: string,
  objectId: string,
  revision: number,
  previousBody: string,
  operations: InteractiveRowsPatch["operations"],
  readHistoricalBody: (revision: number) => Promise<string>,
) {
  const root = await readInteractiveRoot(
    q,
    tenantId,
    objectId,
    interactivePointer(previousBody),
  );
  const references = root.references.map((row) => ({ ...row }));
  const changed = new Map<string, InteractiveRow>();
  const ids = new Set(root.references.map((row) => row.id));
  const columns = new Set(root.columns.map((column) => column.id));
  const row = (id: string) => references.find((row) => row.id === id);
  const data = async (id: string) => {
    const known = changed.get(id);
    if (known) return known;
    const reference = row(id);
    if (!reference) throw new DomainError("invalid", "所选记录不在当前版本。");
    const value = (
      await readInteractiveRows(q, tenantId, objectId, [reference])
    )[0]!;
    changed.set(id, value);
    return value;
  };
  for (const operation of operations) {
    if (operation.type === "update") {
      if ((operation.unset ?? []).some((id) => !columns.has(id)))
        throw new DomainError("invalid", "记录含未定义字段。");
      const value = await data(operation.rowId);
      Object.assign(value.cells, operation.cells);
      for (const id of operation.unset ?? []) delete value.cells[id];
    } else if (operation.type === "delete") {
      const index = references.findIndex((row) => row.id === operation.rowId);
      if (index < 0) throw new DomainError("invalid", "所选记录不在当前版本。");
      references.splice(index, 1);
      ids.delete(operation.rowId);
      changed.delete(operation.rowId);
    } else {
      let value: InteractiveRow;
      if (operation.type === "insert") value = structuredClone(operation.row);
      else {
        const previous = await readInteractiveRoot(
          q,
          tenantId,
          objectId,
          interactivePointer(await readHistoricalBody(operation.fromRevision)),
        );
        const reference = previous.references.find(
          (row) => row.id === operation.rowId,
        );
        if (!reference)
          throw new DomainError("invalid", "恢复来源版本没有这条记录。");
        value = (
          await readInteractiveRows(q, tenantId, objectId, [reference])
        )[0]!;
      }
      if (ids.has(value.id))
        throw new DomainError("invalid", "记录标识已存在。");
      const before = operation.beforeRowId;
      const index =
        before === undefined
          ? references.length
          : references.findIndex((row) => row.id === before);
      if (index < 0) throw new DomainError("invalid", "插入位置记录不存在。");
      const historical =
        operation.type === "restore"
          ? (
              await readInteractiveRoot(
                q,
                tenantId,
                objectId,
                interactivePointer(
                  await readHistoricalBody(operation.fromRevision),
                ),
              )
            ).references.find((row) => row.id === value.id)
          : undefined;
      references.splice(
        index,
        0,
        historical
          ? { ...historical, ordinal: 0 }
          : {
              id: value.id,
              revision,
              sha256: "",
              units: 0,
              ordinal: 0,
            },
      );
      ids.add(value.id);
      changed.set(value.id, value);
    }
  }
  const validation = interactiveSchema.safeParse({
    kind: "interactive",
    layout: root.layout,
    description: root.description,
    columns: root.columns,
    rows: [...changed.values()],
  });
  if (!validation.success)
    throw new DomainError("invalid", validation.error.issues[0]!.message);
  const persisted: InteractiveRow[] = [];
  for (let ordinal = 0; ordinal < references.length; ordinal++) {
    const reference = references[ordinal]!;
    reference.ordinal = ordinal;
    const value = changed.get(reference.id);
    if (!value) continue;
    const body = rowBody(value);
    if (reference.sha256 === sha(body) && reference.revision < revision)
      continue;
    const old = root.references.find((row) => row.id === value.id);
    if (old?.sha256 === sha(body)) {
      Object.assign(reference, { ...old, ordinal });
      continue;
    }
    Object.assign(reference, {
      revision,
      sha256: sha(body),
      units: body.length,
    });
    persisted.push(value);
  }
  return persistRoot(
    q,
    tenantId,
    objectId,
    revision,
    { ...root, references },
    persisted,
    false,
  );
}

export async function queryRows(
  q: SqlQuery,
  backend: "sqlite" | "postgres",
  tenantId: string,
  objectId: string,
  root: InteractiveRoot,
  query: string,
  sort: InteractiveSort | undefined,
  offset: number,
  limit: number,
) {
  if (sort && !root.columns.some((column) => column.id === sort.columnId))
    throw new DomainError("invalid", "排序字段不存在。");
  const contains =
    backend === "sqlite"
      ? "instr(c.search_fold,?)>0"
      : "strpos(c.search_fold,?)>0";
  const filter = query
    ? ` AND EXISTS(SELECT 1 FROM interactive_cells c WHERE c.tenant_id=m.tenant_id AND c.object_id=m.object_id AND c.row_id=m.row_id AND c.row_revision=m.row_revision AND ${contains})`
    : "";
  const base = [
    tenantId,
    objectId,
    root.pointer.tableRevision,
    ...(query ? [query.toLocaleLowerCase()] : []),
  ];
  const total = await q.all<{ count: number | string }>(
    `SELECT COUNT(*) AS count FROM interactive_version_rows m WHERE m.tenant_id=? AND m.object_id=? AND m.object_revision=?${filter}`,
    base,
  );
  const column = sort
    ? root.columns.find((column) => column.id === sort.columnId)!
    : null;
  const sortJoin = column
    ? " LEFT JOIN interactive_cells s ON s.tenant_id=m.tenant_id AND s.object_id=m.object_id AND s.row_id=m.row_id AND s.row_revision=m.row_revision AND s.column_id=?"
    : "";
  // The UI retains its locale-aware display sort. Domain query uses explicit
  // typed/binary keys with an original-order tie break in both SQL backends.
  const value =
    column?.type === "number"
      ? "COALESCE(s.number_value,0)"
      : column?.type === "boolean"
        ? "COALESCE(s.boolean_value,-1)"
        : "COALESCE(s.text_value,'')";
  const collate =
    column?.type === "text"
      ? backend === "postgres"
        ? ' COLLATE "C"'
        : " COLLATE BINARY"
      : "";
  const order = column
    ? `${value}${collate} ${sort?.descending ? "DESC" : "ASC"},m.ordinal,m.row_id`
    : "m.ordinal,m.row_id";
  const selected = await q.all<{ row_id: string }>(
    `SELECT m.row_id FROM interactive_version_rows m${sortJoin} WHERE m.tenant_id=? AND m.object_id=? AND m.object_revision=?${filter} ORDER BY ${order} LIMIT ? OFFSET ?`,
    [...(column ? [column.id] : []), ...base, limit + 1, offset],
  );
  const referenceMap = new Map(root.references.map((row) => [row.id, row]));
  const page = selected.slice(0, limit).map((row) => {
    const reference = referenceMap.get(row.row_id);
    if (!reference) throw new Error("查询行不属于固定版本。");
    return reference;
  });
  const rows = await readInteractiveRows(q, tenantId, objectId, page);
  const summaries = [];
  for (const field of root.columns.filter((field) => field.type === "number")) {
    const result = (
      await q.all<{ count: number | string; sum: number | string | null }>(
        `SELECT COUNT(c.number_value) AS count,SUM(c.number_value) AS sum FROM interactive_version_rows m LEFT JOIN interactive_cells c ON c.tenant_id=m.tenant_id AND c.object_id=m.object_id AND c.row_id=m.row_id AND c.row_revision=m.row_revision AND c.column_id=? AND c.value_kind='number' WHERE m.tenant_id=? AND m.object_id=? AND m.object_revision=?${filter}`,
        [field.id, ...base],
      )
    )[0]!;
    const count = safeInteger(result.count, "统计数量");
    const sum = result.sum === null ? 0 : Number(result.sum);
    summaries.push({
      id: field.id,
      title: field.title,
      count,
      sum,
      mean: count ? sum / count : null,
    });
  }
  return {
    rows,
    matched: safeInteger(total[0]!.count, "匹配行数"),
    hasMore: selected.length > limit,
    summaries,
  };
}
