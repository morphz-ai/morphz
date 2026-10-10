import test from "node:test";
import assert from "node:assert/strict";
import {
  executionJSON,
  executionFieldLabel,
  executionReferenceField,
} from "../apps/web/src/features/execution/execution-json.js";

test("完整 JSON 仅成为呈现树；字符串正文不递归解释，字段顺序与空值保留", () => {
  assert.deepEqual(
    executionJSON(
      ' {"body":"{\\"run\\":true}","empty":"","nil":null,"yes":true,"no":false,"list":[],"object":{}}\n',
    ),
    {
      kind: "object",
      entries: [
        { key: "body", value: { kind: "string", value: '{"run":true}' } },
        { key: "empty", value: { kind: "string", value: "" } },
        { key: "nil", value: { kind: "literal", value: "null" } },
        { key: "yes", value: { kind: "literal", value: "true" } },
        { key: "no", value: { kind: "literal", value: "false" } },
        { key: "list", value: { kind: "array", items: [] } },
        { key: "object", value: { kind: "object", entries: [] } },
      ],
    },
  );
});
test("整数、小数、负零与指数保持原字面值，不经 JS number 舍入", () => {
  const values = [
    "9007199254740993",
    "-9007199254740993",
    "1.00000000000000000001",
    "1e400",
    "-0",
    "1E+03",
  ];
  assert.deepEqual(executionJSON(`[${values.join(",")}]`), {
    kind: "array",
    items: values.map((value) => ({ kind: "literal", value })),
  });
});
test("重复字段和 prototype 名称都作为数据保留，不静默覆盖或取得原型方法", () => {
  assert.deepEqual(
    executionJSON(
      '{"ok":true,"ok":false,"__proto__":{"polluted":true},"constructor":"text"}',
    ),
    {
      kind: "object",
      entries: [
        { key: "ok", value: { kind: "literal", value: "true" } },
        { key: "ok", value: { kind: "literal", value: "false" } },
        {
          key: "__proto__",
          value: {
            kind: "object",
            entries: [
              { key: "polluted", value: { kind: "literal", value: "true" } },
            ],
          },
        },
        { key: "constructor", value: { kind: "string", value: "text" } },
      ],
    },
  );
  assert.equal(executionFieldLabel("__proto__"), "__proto__");
  assert.equal(executionFieldLabel("toString"), "toString");
  assert.equal(Reflect.get(Object.prototype, "polluted"), undefined);
});
test("UTF-8 正文、换行和引号正确解码，HTML 与 URL 仍是字符串", () => {
  const text =
    '林乔："先说清楚。"\n陈屿：好。 <script>不执行</script> https://example.invalid';
  assert.deepEqual(executionJSON(JSON.stringify(text)), {
    kind: "string",
    value: text,
  });
});
test("无效或普通文本不修复、不取局部 JSON、不去代码围栏", () => {
  for (const source of [
    "",
    "plain text",
    "```json\n{}\n```",
    "prefix {}",
    "{} suffix",
    "{",
    "[1,]",
    '{"a":1,}',
    '{"a" 1}',
    "01",
    "-01",
    "1.",
    ".5",
    "1e",
    "truefalse",
    '"bad\\q"',
    '"bad\ncontrol"',
    "\u00a0{}",
    "undefined",
  ])
    assert.equal(executionJSON(source), null, source);
});
test("截断的完整前缀也不被当成完整结果；大小、层级和节点限制回退原文", () => {
  assert.equal(executionJSON('{"ok":true}', true), null);
  assert.ok(executionJSON(JSON.stringify("a".repeat(63_998))));
  assert.equal(executionJSON(JSON.stringify("a".repeat(63_999))), null);
  assert.equal(executionJSON("[".repeat(50) + "0" + "]".repeat(50)), null);
  assert.equal(executionJSON("[" + "0,".repeat(2_048) + "0]"), null);
});
test("已知字段仅翻译名称，未知字段与精确身份不变；引用分组不是授权或重定位", () => {
  assert.equal(executionFieldLabel("body"), "内容");
  assert.equal(executionFieldLabel("futureField"), "futureField");
  assert.equal(executionReferenceField("inputId"), true);
  assert.equal(executionReferenceField("body"), false);
  assert.equal(executionReferenceField("video"), false);
});

test("标准 JSON 字符串与有界复合值与原生解码一致，不改变语义或隐含执行", () => {
  type Tree = NonNullable<ReturnType<typeof executionJSON>>;
  const decoded = (tree: Tree): unknown => {
    if (tree.kind === "string") return tree.value;
    if (tree.kind === "literal") return JSON.parse(tree.value);
    if (tree.kind === "array") return tree.items.map(decoded);
    return Object.fromEntries(
      tree.entries.map(({ key, value }) => [key, decoded(value)]),
    );
  };
  const strings = [
    "",
    '"',
    "\\",
    '\\"',
    "\r\n\t\b\f",
    "\0",
    "剧本正文",
    "😀",
    "\ud800",
    "\udfff",
    "__proto__",
    "<script>不执行</script>",
  ];
  const values = strings.flatMap((text, i) => [
    text,
    [text, i, false, null],
    { body: text, nested: { list: [true, 0.25, -i] } },
  ]);
  for (const input of values) {
    const source = JSON.stringify(input);
    const tree = executionJSON(source);
    assert.ok(tree, source);
    assert.deepEqual(decoded(tree), JSON.parse(source), source);
  }
  assert.deepEqual(executionJSON('"\\u4e00\\uD83D\\uDE00\\/"'), {
    kind: "string",
    value: "一😀/",
  });
  for (const source of [
    '{"x"}',
    "[,0]",
    '{"x":}',
    '"trailing\\',
    '"\\uXXXX"',
    '"\\u123"',
    "[1 2]",
    "[true null]",
    "NaN",
    "Infinity",
    "+1",
    "1e+",
    "\ufeff{}",
  ])
    assert.equal(executionJSON(source), null, source);
});
