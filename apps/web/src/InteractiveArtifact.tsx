import { useState } from "react";
import {
  Plus,
  Trash2,
  Table2,
  ListTodo,
  ChartNoAxesColumn,
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
    <section className="interactive-artifact">
      <div className="interactive-toolbar">
        <div className="filter-tabs" role="group" aria-label="交互视图">
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
              {{ table: "表格", form: "表单", report: "报告" }[mode]}
            </button>
          ))}
        </div>
        <span className="muted">
          {value.rows.length} 条记录{onChange ? " · 编辑后需保存版本" : ""}
        </span>
      </div>
      {onChange ? (
        <label className="field">
          说明
          <textarea
            rows={2}
            value={value.description}
            onChange={(e) =>
              onChange({ ...value, description: e.target.value })
            }
          />
        </label>
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
          <input
            aria-label="筛选记录"
            className="interactive-search"
            placeholder="筛选当前记录"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="interactive-table">
            <table>
              <thead>
                <tr>
                  {value.columns.map((c) => (
                    <th key={c.id}>
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
                  <tr key={row.id}>
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
            {!visible.length && <p className="muted">暂无记录。</p>}
          </div>
        </>
      )}
      {layout === "form" && (
        <div className="interactive-form">
          <label className="field">
            记录
            <select
              aria-label="选择表单记录"
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
          {selected ? (
            value.columns.map((c) => (
              <label className="field" key={c.id}>
                {c.title}
                {c.required ? " *" : ""}
                {cellInput(selected, c)}
              </label>
            ))
          ) : (
            <p className="muted">暂无记录。点击“编辑”后添加。</p>
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
            报告由当前版本数据计算。空值不计入数值均值；未运行生成代码或外部请求。
          </p>
        </div>
      )}
      {onChange && (
        <button
          className="outline"
          disabled={value.rows.length >= 1000}
          onClick={() => {
            const id = crypto.randomUUID();
            setRowId(id);
            onChange({ ...value, rows: [...value.rows, { id, cells: {} }] });
          }}
        >
          <Plus />
          添加记录
        </button>
      )}
    </section>
  );
}
