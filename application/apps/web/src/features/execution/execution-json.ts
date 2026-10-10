/** A display tree, not a tool/Session IO schema or an authority projection.
 * Keep number lexemes and duplicate keys: JSON.parse alone would round large
 * integers and silently lose repeated fields. Raw bytes stay with the caller. */
export type ExecutionJSON =
  | { kind: "string"; value: string }
  | { kind: "literal"; value: string }
  | { kind: "object"; entries: { key: string; value: ExecutionJSON }[] }
  | { kind: "array"; items: ExecutionJSON[] };

/** Only complete, bounded JSON is formatted. Never repair a truncated receipt,
 * strip fences, decode arbitrary body strings, or interpret instructions/HTML. */
export function executionJSON(
  source: string,
  truncated = false,
): ExecutionJSON | null {
  if (truncated || source.length > 64_000 || !source.trim()) return null;
  let at = 0;
  let nodes = 0;
  const whitespace = () => {
    while (at < source.length && /[ \t\r\n]/.test(source[at]!)) at++;
  };
  const string = () => {
    if (source[at] !== '"') throw Error("Not a JSON string");
    const start = at++;
    while (at < source.length) {
      const char = source[at++]!;
      if (char === "\\") at++;
      else if (char === '"')
        // The native string decoder validates escapes/control characters, but
        // never sees an object or number whose information it could discard.
        return JSON.parse(source.slice(start, at)) as string;
    }
    throw Error("Unterminated string");
  };
  const value = (depth: number): ExecutionJSON => {
    if (++nodes > 2_048 || depth > 48) throw Error("Display tree limit");
    whitespace();
    if (source[at] === '"') return { kind: "string", value: string() };
    if (source[at] === "{" || source[at] === "[") {
      const object = source[at++] === "{";
      const close = object ? "}" : "]";
      const entries: { key: string; value: ExecutionJSON }[] = [];
      const items: ExecutionJSON[] = [];
      whitespace();
      if (source[at] !== close) {
        while (true) {
          if (object) {
            whitespace();
            const key = string();
            whitespace();
            if (source[at++] !== ":") throw Error("Missing colon");
            entries.push({ key, value: value(depth + 1) });
          } else items.push(value(depth + 1));
          whitespace();
          if (source[at] === close) break;
          if (source[at++] !== ",") throw Error("Missing comma");
        }
      }
      at++;
      return object ? { kind: "object", entries } : { kind: "array", items };
    }
    const literal =
      /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
        source.slice(at),
      )?.[0];
    if (!literal) throw Error("Not a JSON value");
    at += literal.length;
    return { kind: "literal", value: literal };
  };
  try {
    const result = value(0);
    whitespace();
    return at === source.length ? result : null;
  } catch {
    return null;
  }
}

const labels = new Map(
  Object.entries({
    body: "内容",
    text: "文本",
    note: "说明",
    message: "消息",
    error: "错误",
    warning: "提醒",
    warnings: "提醒",
    title: "标题",
    description: "描述",
    explanation: "创作说明",
    summary: "摘要",
    selection: "选中内容",
    action: "操作",
    parameters: "参数",
    arguments: "参数",
    payload: "数据",
    script: "剧本",
    command: "命令",
    cwd: "工作目录",
    path: "路径",
    stdout: "标准输出",
    stderr: "错误输出",
    code: "代码",
    ok: "返回标记",
    generating: "生成中",
    items: "条目",
    results: "结果",
    candidates: "候选",
    productions: "剧本列表",
    receipt: "回执",
    draft: "文稿",
    draftJson: "文稿 JSON",
    total: "总数",
    hasMore: "还有更多",
    format: "格式",
    offset: "起始位置",
    limit: "上限",
    totalCharacters: "字符总数",
    nextCursor: "下一页游标",
    id: "ID",
    inputId: "输入 ID",
    projectId: "项目 ID",
    productionId: "剧本 ID",
    artifactId: "内容 ID",
    itemId: "条目 ID",
    targetId: "目标条目 ID",
    candidateId: "候选 ID",
    commandId: "命令 ID",
    generationId: "生成 ID",
    activityRevision: "活动修订",
    contextRevision: "上下文修订",
    revision: "修订",
    baseRevision: "基础修订",
    draftHash: "文稿摘要",
    dependencies: "版本依赖",
  }),
);
export const executionFieldLabel = (key: string) => labels.get(key) ?? key;
const references = new Set([
  "id",
  "inputId",
  "projectId",
  "productionId",
  "artifactId",
  "itemId",
  "targetId",
  "candidateId",
  "commandId",
  "generationId",
  "sessionId",
  "contextId",
  "threadId",
  "nextCursor",
  "hasMore",
  "offset",
  "limit",
  "revision",
  "activityRevision",
  "contextRevision",
  "baseRevision",
  "draftHash",
]);
export const executionReferenceField = (key: string) => references.has(key);
