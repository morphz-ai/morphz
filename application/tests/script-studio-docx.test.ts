import assert from "node:assert/strict";
import test from "node:test";
import {
  buildScriptDocx,
  scriptDocxLimits,
} from "../packages/core/src/script-studio-docx.js";
import {
  defaultScriptExportTemplate,
  emptyScriptBrief,
  emptyScriptDraft,
  scriptProductionSchema,
  type ScriptDraft,
  type ScriptItem,
  type ScriptProduction,
} from "../packages/core/src/script-studio.js";

const now = "2026-09-18T10:05:06.000Z";
const author = { principalId: "reviewer", actantId: "human" };
const decoder = new TextDecoder("utf-8", { fatal: true });

function item(
  id: string,
  kind: ScriptItem["kind"],
  patch: Partial<ScriptDraft> = {},
): ScriptItem {
  return {
    id,
    kind,
    revision: 1,
    workflowRevision: 4,
    status: "locked",
    versions: [
      {
        revision: 1,
        draft: { ...emptyScriptDraft(id), ...patch },
        author: { ...author },
        createdAt: now,
        candidateId: null,
      },
    ],
    approval: {
      revision: 1,
      contextRevision: 1,
      author: { ...author },
      createdAt: now,
      note: "审阅通过",
    },
    events: [],
  };
}
function fixture(): ScriptProduction {
  const brief = {
    ...emptyScriptBrief,
    rightsStatement: "原创合成测试资料",
    audience: "测试读者",
    style: "简洁对白",
  };
  const template = { ...defaultScriptExportTemplate };
  const items = [
    item("ep-b", "episode", { title: "第二集", order: 20, text: "第二集大纲" }),
    item("scene-z", "scene", {
      title: "场景Z",
      parentId: "ep-a",
      order: 10,
      dependencies: [{ itemId: "ep-a", revision: 1 }],
      text: "第二场正文",
    }),
    item("hero", "character", { title: "主角林舟", text: "角色设定正文" }),
    item("ep-a", "episode", { title: "第一集", order: 10, text: "第一集大纲" }),
    item("scene-a", "scene", {
      title: "场景A",
      parentId: "ep-a",
      order: 10,
      dependencies: [
        { itemId: "ep-a", revision: 1 },
        { itemId: "hero", revision: 1 },
      ],
      characters: ["hero"],
      text: "  林舟：你好 & <朋友> \"电影\" '台词'\t下一拍\n\n第二行 😀\r\n末行\r尾声\u0000\u000b\u001b\ud800\ufffe\uffff",
      sources: [
        {
          artifactId: "source-original",
          revision: 4,
          quote: "原文：<授权> & 保留",
        },
      ],
      basis: "adaptation",
      location: "小屋",
      storyTime: "雨夜",
      productionNotes: "制作说明唯一标记",
      audienceKnowledge: "观众知识唯一标记",
      characterKnowledge: "角色知识唯一标记",
      setupPayoff: "伏笔兑现唯一标记",
    }),
    item("scene-b", "scene", {
      title: "场景B",
      parentId: "ep-b",
      order: 0,
      dependencies: [{ itemId: "ep-b", revision: 1 }],
      text: "第二集场景正文",
    }),
    {
      ...item("not-selected", "outline", {
        text: "绝不应出现在交付文件的未选稿",
      }),
      status: "draft" as const,
      approval: null,
    },
  ];
  return scriptProductionSchema.parse({
    id: "production",
    projectId: "project",
    title: "昼与夜 & <测试>",
    revision: 1,
    brief,
    reviewerPrincipalIds: [author.principalId],
    createdBy: author,
    createdAt: now,
    updatedAt: now,
    items,
    candidates: [],
    reviews: [],
    template,
    metadataHistory: [
      {
        revision: 1,
        title: "昼与夜 & <测试>",
        brief,
        reviewerPrincipalIds: [author.principalId],
        template,
        author,
        createdAt: now,
      },
    ],
    exports: [
      {
        id: "export-1",
        createdBy: author,
        createdAt: now,
        contextRevision: 1,
        items: ["scene-b", "ep-b", "hero", "scene-z", "ep-a", "scene-a"].map(
          (itemId) => ({ itemId, revision: 1 }),
        ),
        template,
        format: "docx",
      },
    ],
  });
}
function draft(production: ScriptProduction, id: string) {
  return production.items.find((i) => i.id === id)!.versions[0]!.draft;
}

// Independent, bit-at-a-time CRC implementation (the exporter uses a table).
function crc32(data: Uint8Array) {
  let value = 0xffffffff;
  for (const byte of data) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++)
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function unpack(data: Uint8Array): Map<string, string> {
  assert.ok(data instanceof Uint8Array);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  const end = data.length - 22;
  assert.equal(u32(end), 0x06054b50, "EOCD is the exact archive end");
  assert.equal(u16(end + 4), 0);
  assert.equal(u16(end + 6), 0);
  assert.equal(u16(end + 20), 0);
  const count = u16(end + 10);
  assert.equal(u16(end + 8), count);
  const centralOffset = u32(end + 16);
  const centralSize = u32(end + 12);
  assert.equal(centralOffset + centralSize, end);
  let offset = centralOffset;
  let localEnd = 0;
  const entries = new Map<string, string>();
  for (let n = 0; n < count; n++) {
    assert.equal(u32(offset), 0x02014b50);
    assert.equal(u16(offset + 6), 20);
    assert.equal(
      u16(offset + 8),
      0x0800,
      "UTF-8 names, no encryption/data descriptor",
    );
    assert.equal(u16(offset + 10), 0, "stored entries");
    const checksum = u32(offset + 16);
    const size = u32(offset + 20);
    assert.equal(u32(offset + 24), size);
    const nameSize = u16(offset + 28);
    assert.equal(u16(offset + 30), 0);
    assert.equal(u16(offset + 32), 0);
    assert.equal(u16(offset + 34), 0);
    const local = u32(offset + 42);
    assert.equal(
      local,
      localEnd,
      "no gaps, hidden entries or overlapping local entries",
    );
    const name = decoder.decode(
      data.subarray(offset + 46, offset + 46 + nameSize),
    );
    assert.equal(entries.has(name), false);
    assert.equal(u32(local), 0x04034b50);
    assert.equal(u16(local + 4), 20);
    assert.equal(u16(local + 6), 0x0800);
    assert.equal(u16(local + 8), 0);
    assert.equal(u16(local + 10), u16(offset + 12));
    assert.equal(u16(local + 12), u16(offset + 14));
    assert.equal(u32(local + 14), checksum);
    assert.equal(u32(local + 18), size);
    assert.equal(u32(local + 22), size);
    assert.equal(u16(local + 26), nameSize);
    assert.equal(u16(local + 28), 0);
    assert.equal(
      decoder.decode(data.subarray(local + 30, local + 30 + nameSize)),
      name,
    );
    const start = local + 30 + nameSize;
    localEnd = start + size;
    assert.ok(localEnd <= centralOffset);
    const content = data.subarray(start, localEnd);
    assert.equal(crc32(content), checksum, name + " CRC");
    entries.set(name, decoder.decode(content));
    offset += 46 + nameSize;
  }
  assert.equal(localEnd, centralOffset);
  assert.equal(offset, end);
  return entries;
}
function document(production = fixture()) {
  return unpack(buildScriptDocx(production, "export-1")).get(
    "word/document.xml",
  )!;
}

test("script DOCX is a complete OPC ZIP with matching directories, UTF-8 and independent CRCs", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  const parts = unpack(buildScriptDocx(fixture(), "export-1"));
  assert.deepEqual(
    [...parts.keys()],
    [
      "[Content_Types].xml",
      "_rels/.rels",
      "word/document.xml",
      "word/styles.xml",
      "word/_rels/document.xml.rels",
      "docProps/core.xml",
      "docProps/app.xml",
    ],
  );
  const types = parts.get("[Content_Types].xml")!;
  assert.match(
    types,
    /application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document\.main\+xml/,
  );
  assert.match(types, /PartName="\/word\/styles.xml"/);
  assert.match(parts.get("_rels/.rels")!, /Target="word\/document.xml"/);
  assert.match(
    parts.get("word/_rels/document.xml.rels")!,
    /Target="styles.xml"/,
  );
  assert.match(
    parts.get("docProps/core.xml")!,
    /<dc:identifier>export-1<\/dc:identifier>/,
  );
  assert.match(
    parts.get("docProps/core.xml")!,
    /<dc:creator>human \(reviewer\)<\/dc:creator>/,
  );
  assert.match(parts.get("docProps/app.xml")!, /Morphz Script Studio/);
  for (const [name, xml] of parts) {
    assert.match(
      xml,
      /^<\?xml version="1.0" encoding="UTF-8" standalone="yes"\?>/,
    );
    assert.doesNotMatch(
      xml,
      /<!DOCTYPE|<!ENTITY|TargetMode="External"|<script/i,
      name,
    );
  }
});

test("script DOCX preserves Chinese, emoji, spaces, tabs and blank/newline structure while escaping XML", () => {
  const xml = document();
  assert.match(xml, /昼与夜 &amp; &lt;测试&gt;/);
  assert.match(
    xml,
    /<w:t xml:space="preserve">  林舟：你好 &amp; &lt;朋友&gt; &quot;电影&quot; &apos;台词&apos;<\/w:t><w:tab\/>/,
  );
  assert.match(xml, /<w:t xml:space="preserve"><\/w:t>/);
  assert.match(xml, /第二行 😀/);
  assert.match(xml, /尾声\ufffd{6}/);
  assert.doesNotMatch(xml, /[\u0000\u000b\u001b\ud800\ufffe\uffff]/u);
  assert.match(xml, /source-original v4/);
  assert.match(xml, /原文：&lt;授权&gt; &amp; 保留/);
  assert.match(xml, /scene-a v1/);
  assert.match(xml, /hero v1/);
  assert.doesNotMatch(xml, /绝不应出现在交付文件的未选稿/);
  assert.equal((xml.match(/<w:pageBreakBefore\/>/g) ?? []).length, 2);
  assert.match(xml, /<w:pgSz w:w="11906" w:h="16838"\/>/);
  assert.match(
    xml,
    /w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/,
  );
});

test("script DOCX uses only pinned template options for notes, continuity, heading, font and pagination", () => {
  const production = fixture();
  production.template.font = "Arial";
  const record = production.exports[0]!;
  record.template = {
    ...record.template,
    title: "制片用稿",
    includeNotes: false,
    includeContinuity: true,
    pageBreakEpisodes: false,
    font: "等线",
    fontSize: 18,
    sceneHeading: "拍摄场",
  };
  const parts = unpack(buildScriptDocx(production, record.id));
  const xml = parts.get("word/document.xml")!;
  assert.match(xml, /制片用稿/);
  assert.match(xml, /拍摄场 · 场景A/);
  assert.doesNotMatch(xml, /制作说明唯一标记/);
  for (const content of [
    "观众知识唯一标记",
    "角色知识唯一标记",
    "伏笔兑现唯一标记",
  ])
    assert.ok(xml.includes(content));
  assert.doesNotMatch(xml, /<w:pageBreakBefore/);
  const styles = parts.get("word/styles.xml")!;
  assert.match(styles, /w:eastAsia="等线"/);
  assert.match(styles, /<w:sz w:val="36"\/>/);
  assert.doesNotMatch(styles, /Arial/);
  const defaults = document();
  assert.match(defaults, /制作说明唯一标记/);
  assert.doesNotMatch(
    defaults,
    /观众知识唯一标记|角色知识唯一标记|伏笔兑现唯一标记/,
  );
});

test("script DOCX sorts by episode/order/stable ID and ignores storage/reference order", () => {
  const production = fixture();
  const xml = document(production);
  const markers = [
    "角色 · 主角林舟",
    "分集 · 第一集",
    "场景 · 场景A",
    "场景 · 场景Z",
    "分集 · 第二集",
    "场景 · 场景B",
  ];
  const positions = markers.map((marker) => xml.indexOf(marker));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(
    positions,
    [...positions].sort((a, b) => a - b),
  );
  const before = buildScriptDocx(production, "export-1");
  production.items.reverse();
  production.exports[0]!.items.reverse();
  assert.deepEqual(buildScriptDocx(production, "export-1"), before);
});

test("script DOCX historical receipt is byte-identical after later edits, unlocks, metadata and template changes", () => {
  const production = fixture();
  const before = buildScriptDocx(production, "export-1");
  production.revision = 2;
  production.title = "后来的剧名";
  production.brief.style = "后来的风格";
  production.template.font = "Arial";
  production.reviewerPrincipalIds = ["new-reviewer"];
  production.metadataHistory.push({
    ...structuredClone(production.metadataHistory[0]!),
    revision: 2,
    title: production.title,
  });
  for (const entry of production.items) {
    entry.versions.push({
      ...structuredClone(entry.versions[0]!),
      revision: 2,
      draft: {
        ...structuredClone(entry.versions[0]!.draft),
        text: "新正文不能渗入历史交付",
      },
    });
    entry.revision = 2;
    entry.workflowRevision++;
    entry.status = "draft";
    entry.approval = null;
  }
  production.items.push(item("later", "outline", { text: "后来新建的内容" }));
  production.exports.push({
    ...structuredClone(production.exports[0]!),
    id: "export-later",
    contextRevision: 2,
  });
  assert.deepEqual(buildScriptDocx(production, "export-1"), before);
});

test("script DOCX dependencies not selected for printing stay references, with their historical versions validated", () => {
  const production = fixture();
  production.exports[0]!.items = production.exports[0]!.items.filter(
    (i) => i.itemId !== "hero",
  );
  assert.doesNotMatch(document(production), /角色设定正文/);
  assert.match(document(production), /hero v1/);
  production.items.find((i) => i.id === "hero")!.versions = [];
  assert.throws(
    () => buildScriptDocx(production, "export-1"),
    /依赖的历史版本缺失/,
  );
});

test("script DOCX fails closed for missing/duplicate export, metadata, items and pinned versions", () => {
  const cases: Array<[string, (p: ScriptProduction) => void, RegExp]> = [
    [
      "missing receipt",
      (p) => {
        p.exports = [];
      },
      /导出记录不存在/,
    ],
    [
      "duplicate receipt",
      (p) => {
        p.exports.push(structuredClone(p.exports[0]!));
      },
      /不唯一/,
    ],
    [
      "missing metadata",
      (p) => {
        p.metadataHistory = [];
      },
      /项目历史版本缺失/,
    ],
    [
      "duplicate metadata",
      (p) => {
        p.metadataHistory.push(structuredClone(p.metadataHistory[0]!));
      },
      /不唯一/,
    ],
    [
      "missing item",
      (p) => {
        p.items = p.items.filter((i) => i.id !== "scene-a");
      },
      /历史条目不存在/,
    ],
    [
      "duplicate item",
      (p) => {
        p.items.push(structuredClone(p.items[0]!));
      },
      /条目 ID 重复/,
    ],
    [
      "missing version",
      (p) => {
        p.items.find((i) => i.id === "scene-a")!.versions = [];
      },
      /历史版本缺失/,
    ],
    [
      "duplicate version",
      (p) => {
        const i = p.items.find((i) => i.id === "scene-a")!;
        i.versions.push(structuredClone(i.versions[0]!));
      },
      /不唯一/,
    ],
    [
      "duplicate reference",
      (p) => {
        p.exports[0]!.items.push(structuredClone(p.exports[0]!.items[0]!));
      },
      /导出引用重复/,
    ],
    [
      "empty export",
      (p) => {
        p.exports[0]!.items = [];
      },
      /导出条目数量无效/,
    ],
  ];
  for (const [label, mutate, error] of cases) {
    const production = fixture();
    mutate(production);
    assert.throws(() => buildScriptDocx(production, "export-1"), error, label);
  }
});

test("script DOCX rejects orphan scenes, mismatched dependency revisions and invalid character references", () => {
  const cases: Array<[string, (p: ScriptProduction) => void, RegExp]> = [
    [
      "parent not selected",
      (p) => {
        p.exports[0]!.items = p.exports[0]!.items.filter(
          (i) => i.itemId !== "ep-a",
        );
      },
      /缺少同批导出/,
    ],
    [
      "missing parent",
      (p) => {
        draft(p, "scene-a").parentId = null;
      },
      /缺少同批导出/,
    ],
    [
      "wrong parent type",
      (p) => {
        draft(p, "scene-a").parentId = "hero";
      },
      /缺少同批导出/,
    ],
    [
      "missing parent version binding",
      (p) => {
        draft(p, "scene-a").dependencies.shift();
      },
      /所属集的历史版本不一致/,
    ],
    [
      "mismatched revision",
      (p) => {
        const ep = p.items.find((i) => i.id === "ep-a")!;
        ep.versions.push({ ...structuredClone(ep.versions[0]!), revision: 2 });
        draft(p, "scene-a").dependencies[0]!.revision = 2;
      },
      /依赖版本不一致/,
    ],
    [
      "duplicate dependency",
      (p) => {
        draft(p, "scene-a").dependencies.push({ itemId: "ep-a", revision: 1 });
      },
      /依赖引用重复/,
    ],
    [
      "self reference",
      (p) => {
        draft(p, "scene-a").dependencies.push({
          itemId: "scene-a",
          revision: 1,
        });
      },
      /引用自身/,
    ],
    [
      "parent on non scene",
      (p) => {
        draft(p, "ep-a").parentId = "ep-b";
      },
      /非分场条目/,
    ],
    [
      "character without pinned version",
      (p) => {
        draft(p, "scene-a").characters = ["not-selected"];
      },
      /出场角色缺少版本/,
    ],
    [
      "wrong character kind",
      (p) => {
        draft(p, "scene-a").characters = ["ep-a"];
      },
      /出场角色引用类型不符/,
    ],
    [
      "duplicate character",
      (p) => {
        draft(p, "scene-a").characters.push("hero");
      },
      /出场角色重复/,
    ],
  ];
  for (const [label, mutate, error] of cases) {
    const production = fixture();
    mutate(production);
    assert.throws(() => buildScriptDocx(production, "export-1"), error, label);
  }
});

test("script DOCX has deterministic archive bytes in different local timezones and never mutates input", () => {
  const production = fixture();
  const original = structuredClone(production);
  const timezone = process.env.TZ;
  try {
    process.env.TZ = "America/Los_Angeles";
    const west = buildScriptDocx(production, "export-1");
    process.env.TZ = "Asia/Shanghai";
    assert.deepEqual(buildScriptDocx(production, "export-1"), west);
  } finally {
    if (timezone === undefined) delete process.env.TZ;
    else process.env.TZ = timezone;
  }
  assert.deepEqual(production, original);
});

test("script DOCX rejects excessive source and XML expansion before creating a ZIP", () => {
  const production = fixture();
  const count = Math.ceil(scriptDocxLimits.sourceCharacters / 100_000) + 1;
  production.items = Array.from({ length: count }, (_, n) =>
    item(`large-${n}`, "outline", { text: "文".repeat(100_000) }),
  );
  production.exports[0]!.items = production.items.map((i) => ({
    itemId: i.id,
    revision: 1,
  }));
  assert.throws(() => buildScriptDocx(production, "export-1"), /原文过大/);
  production.items = Array.from({ length: 3 }, (_, n) =>
    item(`lines-${n}`, "outline", { text: "\n".repeat(100_000) }),
  );
  production.exports[0]!.items = production.items.map((i) => ({
    itemId: i.id,
    revision: 1,
  }));
  assert.throws(
    () => buildScriptDocx(production, "export-1"),
    /排版后内容过大/,
  );
  production.exports[0]!.items = Array.from(
    { length: scriptDocxLimits.items + 1 },
    (_, n) => ({ itemId: `overflow-${n}`, revision: 1 }),
  );
  assert.throws(
    () => buildScriptDocx(production, "export-1"),
    /导出条目数量过多/,
  );
});
