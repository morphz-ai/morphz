import { useLayoutEffect, useRef, useState } from "react";
import {
  Plus,
  Trash2,
  Table2,
  ListTodo,
  ChartNoAxesColumn,
  Search,
  X,
} from "lucide-react";
import {
  interactiveSummary,
  type InteractiveContent,
} from "../../../packages/core/src/interactive.js";

export function InteractiveArtifact({
  value,
  onChange,
}: {
  value: InteractiveContent;
  onChange?: (value: InteractiveContent) => void;
}) {
  const [layout, setLayout] = useState(value.layout),
    [query, setQuery] = useState(""),
    [sort, setSort] = useState<{ column: string; desc: boolean } | null>(null),
    [rowId, setRowId] = useState(value.rows[0]?.id ?? "");
  const selected = value.rows.find((r) => r.id === rowId) ?? value.rows[0];
  const surface = useRef<HTMLElement>(null);
  const focusRow = useRef<string | null>(null);
  useLayoutEffect(() => {
    const id = focusRow.current;
    if (!id) return;
    const row = Array.from(
      surface.current?.querySelectorAll<HTMLElement>("[data-row-id]") ?? [],
    ).find((element) => element.dataset.rowId === id);
    const field = row?.querySelector<HTMLInputElement>("input");
    if (field) {
      field.focus();
      field.scrollIntoView({ block: "nearest" });
      focusRow.current = null;
    }
  }, [value.rows]);
  function addRow() {
    const id = crypto.randomUUID();
    setQuery("");
    setSort(null);
    setRowId(id);
    if (layout === "report") setLayout("table");
    focusRow.current = id;
    onChange?.({ ...value, rows: [...value.rows, { id, cells: {} }] });
  }
  function changeCell(
    row: string,
    column: string,
    cell: string | number | boolean | null,
  ) {
    onChange?.({
      ...value,
      rows: value.rows.map((r) =>
        r.id === row ? { ...r, cells: { ...r.cells, [column]: cell } } : r,
      ),
    });
  }
  function cellInput(
    row: InteractiveContent["rows"][number],
    column: InteractiveContent["columns"][number],
  ) {
    const cell = row.cells[column.id];
    if (!onChange)
      return (
        <span>
          {typeof cell === "boolean"
            ? cell
              ? "是"
              : "否"
            : String(cell ?? "—")}
        </span>
      );
    return column.type === "boolean" ? (
      <input
        type="checkbox"
        aria-label={`${column.title} ${row.id}`}
        checked={cell === true}
        onChange={(e) => changeCell(row.id, column.id, e.target.checked)}
      />
    ) : (
      <input
        aria-label={`${column.title} ${row.id}`}
        type={column.type === "number" ? "number" : "text"}
        required={column.required}
        value={typeof cell === "string" || typeof cell === "number" ? cell : ""}
        onChange={(e) =>
          changeCell(
            row.id,
            column.id,
            e.target.value === ""
              ? null
              : column.type === "number"
                ? Number(e.target.value)
                : e.target.value,
          )
        }
      />
    );
  }
  const visible = value.rows
    .filter(
      (r) =>
        !query.trim() ||
        Object.values(r.cells).some((v) =>
          String(v ?? "")
            .toLocaleLowerCase()
            .includes(query.toLocaleLowerCase()),
        ),
    )
    .sort((a, b) => {
      if (!sort) return 0;
      const x = a.cells[sort.column],
        y = b.cells[sort.column];
      const n =
        typeof x === "number" && typeof y === "number"
          ? x - y
          : String(x ?? "").localeCompare(String(y ?? ""));
      return sort.desc ? -n : n;
    });
  return (
    <section ref={surface} className="interactive-artifact">
      <div className="interactive-toolbar">
        <div className="filter-tabs" role="group" aria-label="表格视图">
          {(["table", "form", "report"] as const).map((mode) => (
            <button
              key={mode}
              aria-pressed={layout === mode}
              onClick={() => {
                setLayout(mode);
                onChange?.({ ...value, layout: mode });
              }}
            >
              {mode === "table" ? (
                <Table2 />
              ) : mode === "form" ? (
                <ListTodo />
              ) : (
                <ChartNoAxesColumn />
              )}
              {{ table: "表格", form: "记录", report: "统计" }[mode]}
            </button>
          ))}
        </div>
        {layout === "table" && (
          <label className="interactive-search-field">
            <Search size={14} />
            <input
              aria-label="筛选记录"
              placeholder="筛选记录"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button aria-label="清除记录筛选" onClick={() => setQuery("")}>
                <X size={14} />
              </button>
            )}
          </label>
        )}
        <span className="muted">
          {layout === "table" && query.trim()
            ? `${visible.length} / ${value.rows.length}`
            : value.rows.length}{" "}
          条记录
        </span>
        {onChange && (
          <button
            className="outline"
            disabled={value.rows.length >= 1000}
            onClick={addRow}
          >
            <Plus />
            添加记录
          </button>
        )}
      </div>
      {onChange ? (
        <details className="interactive-description">
          <summary>说明{value.description ? " · 已填写" : " · 可选"}</summary>
          <label className="field">
            <textarea
              aria-label="说明"
              rows={2}
              value={value.description}
              onChange={(e) =>
                onChange({ ...value, description: e.target.value })
              }
            />
          </label>
        </details>
      ) : (
        value.description && <p>{value.description}</p>
      )}
      {onChange && (
        <details className="interactive-fields">
          <summary>字段设置</summary>
          {value.columns.map((column) => (
            <div className="interactive-field" key={column.id}>
              <input
                aria-label={`字段名称 ${column.id}`}
                value={column.title}
                onChange={(e) =>
                  onChange({
                    ...value,
                    columns: value.columns.map((c) =>
                      c.id === column.id ? { ...c, title: e.target.value } : c,
                    ),
                  })
                }
              />
              <span>
                {{ text: "文本", number: "数字", boolean: "勾选" }[column.type]}
              </span>
              <label>
                <input
                  type="checkbox"
                  checked={column.required}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      columns: value.columns.map((c) =>
                        c.id === column.id
                          ? { ...c, required: e.target.checked }
                          : c,
                      ),
                    })
                  }
                />
                必填
              </label>
              <button
                aria-label={`删除字段 ${column.title}`}
                disabled={value.columns.length === 1}
                onClick={() =>
                  onChange({
                    ...value,
                    columns: value.columns.filter((c) => c.id !== column.id),
                    rows: value.rows.map((r) => ({
                      ...r,
                      cells: Object.fromEntries(
                        Object.entries(r.cells).filter(
                          ([id]) => id !== column.id,
                        ),
                      ),
                    })),
                  })
                }
              >
                <Trash2 />
              </button>
            </div>
          ))}
          <div className="inline">
            {(["text", "number", "boolean"] as const).map((type) => (
              <button
                key={type}
                disabled={value.columns.length >= 24}
                onClick={() =>
                  onChange({
                    ...value,
                    columns: [
                      ...value.columns,
                      {
                        id: crypto.randomUUID(),
                        title: {
                          text: "文本",
                          number: "数值",
                          boolean: "完成",
                        }[type],
                        type,
                        required: false,
                      },
                    ],
                  })
                }
              >
                <Plus />
                添加{{ text: "文本", number: "数字", boolean: "勾选" }[type]}
              </button>
            ))}
          </div>
        </details>
      )}
      {layout === "table" && (
        <>
          <div className="interactive-table">
            <table>
              <thead>
                <tr>
                  {value.columns.map((c) => (
                    <th
                      key={c.id}
                      aria-sort={
                        sort?.column === c.id
                          ? sort.desc
                            ? "descending"
                            : "ascending"
                          : "none"
                      }
                    >
                      <button
                        onClick={() =>
                          setSort({
                            column: c.id,
                            desc: sort?.column === c.id ? !sort.desc : false,
                          })
                        }
                      >
                        {c.title}
                        {c.required ? " *" : ""}
                        {sort?.column === c.id ? (sort.desc ? " ↓" : " ↑") : ""}
                      </button>
                    </th>
                  ))}
                  {onChange && <th>操作</th>}
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr key={row.id} data-row-id={row.id}>
                    {value.columns.map((c) => (
                      <td key={c.id}>{cellInput(row, c)}</td>
                    ))}
                    {onChange && (
                      <td>
                        <button
                          aria-label={`删除记录 ${row.id}`}
                          onClick={() =>
                            onChange({
                              ...value,
                              rows: value.rows.filter((r) => r.id !== row.id),
                            })
                          }
                        >
                          <Trash2 />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {!visible.length && (
              <p className="interactive-empty">
                {query.trim()
                  ? "没有匹配的记录。"
                  : onChange
                    ? "暂无记录"
                    : "暂无记录。"}
                {query.trim() && (
                  <button onClick={() => setQuery("")}>清除筛选</button>
                )}
              </p>
            )}
          </div>
        </>
      )}
      {layout === "form" && (
        <div className="interactive-form" data-row-id={selected?.id}>
          {!!value.rows.length && (
            <label className="field">
              记录
              <select
                aria-label="选择记录"
                value={selected?.id ?? ""}
                onChange={(e) => setRowId(e.target.value)}
              >
                {value.rows.map((r, i) => (
                  <option value={r.id} key={r.id}>
                    {String(r.cells[value.columns[0]!.id] ?? `记录 ${i + 1}`)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {selected ? (
            value.columns.map((c) => (
              <label className="field" key={c.id}>
                {c.title}
                {c.required ? " *" : ""}
                {cellInput(selected, c)}
              </label>
            ))
          ) : (
            <p className="muted">暂无记录</p>
          )}
        </div>
      )}
      {layout === "report" && (
        <div className="interactive-report">
          <div>
            <span>记录数</span>
            <strong>{value.rows.length}</strong>
          </div>
          {interactiveSummary(value).map((s) => (
            <div key={s.id}>
              <span>{s.title} · 合计</span>
              <strong>{s.sum.toLocaleString()}</strong>
              <small>
                {s.count} 个有效数值 · 均值{" "}
                {s.mean?.toLocaleString(undefined, {
                  maximumFractionDigits: 2,
                }) ?? "—"}
              </small>
            </div>
          ))}
          <p className="muted">
            根据{onChange ? "当前草稿" : "当前版本"}计算，空值不计入均值。
          </p>
        </div>
      )}
    </section>
  );
}
