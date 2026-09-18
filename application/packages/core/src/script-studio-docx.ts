import {
  scriptBriefSchema,
  scriptDraftSchema,
  scriptItemSchema,
  scriptKindLabels,
  scriptProductionSchema,
  type ScriptDraft,
  type ScriptItem,
  type ScriptProduction,
} from "./script-studio.js";

/** Limits apply before allocating the archive; no ZIP64 or unbounded export. */
export const scriptDocxLimits = Object.freeze({
  items: 5000,
  sourceCharacters: 4_000_000,
  xmlCharacters: 16_000_000,
  archiveBytes: 32 * 1024 * 1024,
});

const encoder = new TextEncoder();
const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const wns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const relns = "http://schemas.openxmlformats.org/package/2006/relationships";
const officeRelns =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

type ExportRecord = ScriptProduction["exports"][number];
type PinnedItem = {
  id: string;
  kind: ScriptItem["kind"];
  revision: number;
  draft: ScriptDraft;
};

function invalid(message: string): never {
  throw new Error(`无法导出 Word：${message}`);
}

/** Replace invalid XML 1.0 characters, including isolated UTF-16 surrogates. */
function xml(value: string): string {
  let result = "";
  for (const char of value) {
    const cp = char.codePointAt(0)!;
    const valid =
      cp === 9 ||
      cp === 10 ||
      cp === 13 ||
      (cp >= 0x20 && cp <= 0xd7ff) ||
      (cp >= 0xe000 && cp <= 0xfffd) ||
      (cp >= 0x10000 && cp <= 0x10ffff);
    result += !valid
      ? "\ufffd"
      : ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&apos;",
        }[char] ?? char);
  }
  return result;
}

function run(text: string): string {
  return `<w:r>${text
    .split(/(\r\n|\r|\n|\t)/)
    .map((part) =>
      part === "\t"
        ? "<w:tab/>"
        : /^(\r\n|\r|\n)$/.test(part)
          ? "<w:br/>"
          : `<w:t xml:space="preserve">${xml(part)}</w:t>`,
    )
    .join("")}</w:r>`;
}

class DocumentXml {
  private readonly parts: string[] = [];
  private characters = 0;

  add(value: string) {
    this.characters += value.length;
    if (this.characters > scriptDocxLimits.xmlCharacters)
      invalid("排版后内容过大，请拆分为较少集数导出。");
    this.parts.push(value);
  }

  paragraph(text: string, style = "BodyText", pageBreak = false) {
    this.add(
      `<w:p><w:pPr><w:pStyle w:val="${style}"/>${pageBreak ? "<w:pageBreakBefore/>" : ""}</w:pPr>${run(text)}</w:p>`,
    );
  }

  lines(text: string, style = "BodyText") {
    // One paragraph per source line preserves blank lines, spaces and tabs.
    for (const line of text.split(/\r\n|\r|\n/)) this.paragraph(line, style);
  }

  field(label: string, value: string, style = "Metadata") {
    if (value) this.lines(`${label}：${value}`, style);
  }

  finish() {
    return this.parts.join("");
  }
}

function byOrder(a: PinnedItem, b: PinnedItem) {
  // localeCompare would make byte identity depend on the host's ICU/locale.
  return (
    a.draft.order - b.draft.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

function pinnedItems(production: ScriptProduction, record: ExportRecord) {
  if (!record.items.length || record.items.length > scriptDocxLimits.items)
    invalid("导出条目数量无效。");
  const selected = new Map<string, PinnedItem>();
  const all = new Map<string, ScriptItem>();
  for (const item of production.items) {
    if (all.has(item.id)) invalid(`条目 ID 重复：${item.id}`);
    all.set(item.id, item);
  }
  let characters = 0;
  for (const ref of record.items) {
    if (selected.has(ref.itemId)) invalid(`导出引用重复：${ref.itemId}`);
    const item = all.get(ref.itemId);
    if (!item) invalid(`历史条目不存在：${ref.itemId}`);
    const versions = item.versions.filter((v) => v.revision === ref.revision);
    if (versions.length !== 1)
      invalid(`历史版本缺失或不唯一：${ref.itemId} v${ref.revision}`);
    const draft = scriptDraftSchema.parse(versions[0]!.draft);
    for (const value of Object.values(draft))
      if (typeof value === "string") characters += value.length;
    for (const source of draft.sources)
      characters += source.artifactId.length + source.quote.length;
    for (const dependency of draft.dependencies)
      characters += dependency.itemId.length;
    for (const character of draft.characters) characters += character.length;
    if (characters > scriptDocxLimits.sourceCharacters)
      invalid("原文过大，请拆分为较少集数导出。");
    selected.set(ref.itemId, {
      id: ref.itemId,
      kind: scriptItemSchema.shape.kind.parse(item.kind),
      revision: ref.revision,
      draft,
    });
  }
  for (const item of selected.values()) {
    const { draft } = item;
    const dependencies = new Map<string, number>();
    for (const ref of draft.dependencies) {
      if (dependencies.has(ref.itemId) || ref.itemId === item.id)
        invalid(`依赖引用重复或引用自身：${item.id}`);
      dependencies.set(ref.itemId, ref.revision);
      const historical = all.get(ref.itemId);
      if (
        !historical ||
        historical.versions.filter((v) => v.revision === ref.revision)
          .length !== 1
      )
        invalid(
          `依赖的历史版本缺失或不唯一：${item.id} → ${ref.itemId} v${ref.revision}`,
        );
      const other = selected.get(ref.itemId);
      if (other && other.revision !== ref.revision)
        invalid(`导出条目之间的依赖版本不一致：${item.id} → ${ref.itemId}`);
    }
    if (new Set(draft.characters).size !== draft.characters.length)
      invalid(`出场角色重复：${item.id}`);
    for (const characterId of draft.characters) {
      if (!dependencies.has(characterId))
        invalid(`出场角色缺少版本引用：${item.id}`);
      const character = all.get(characterId);
      if (!character || character.kind !== "character")
        invalid(`出场角色引用类型不符：${item.id}`);
    }
    if (item.kind === "scene") {
      const parent = draft.parentId ? selected.get(draft.parentId) : undefined;
      if (!parent || parent.kind !== "episode")
        invalid(`分场缺少同批导出的所属集：${item.id}`);
      if (dependencies.get(parent.id) !== parent.revision)
        invalid(`分场与所属集的历史版本不一致：${item.id}`);
    } else if (draft.parentId !== null) {
      invalid(`非分场条目不能指定所属集：${item.id}`);
    }
  }
  return [...selected.values()];
}

function styles(font: string, size: number) {
  const fonts = `<w:rFonts w:ascii="${xml(font)}" w:hAnsi="${xml(font)}" w:eastAsia="${xml(font)}" w:cs="${xml(font)}"/>`;
  const heading = (
    id: string,
    name: string,
    halfPoints: number,
    level: number,
  ) =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="BodyText"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="200" w:after="100"/><w:outlineLvl w:val="${level}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${halfPoints}"/><w:szCs w:val="${halfPoints}"/></w:rPr></w:style>`;
  return `${declaration}<w:styles xmlns:w="${wns}"><w:docDefaults><w:rPrDefault><w:rPr>${fonts}<w:sz w:val="${size * 2}"/><w:szCs w:val="${size * 2}"/><w:lang w:val="zh-CN" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:widowControl/><w:spacing w:after="80" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="paragraph" w:styleId="BodyText"><w:name w:val="Body Text"/><w:basedOn w:val="Normal"/><w:qFormat/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:after="200"/><w:jc w:val="center"/></w:pPr><w:rPr><w:b/><w:sz w:val="${(size + 8) * 2}"/><w:szCs w:val="${(size + 8) * 2}"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:jc w:val="center"/></w:pPr></w:style>${heading("Heading1", "heading 1", (size + 4) * 2, 0)}${heading("Heading2", "heading 2", (size + 2) * 2, 1)}<w:style w:type="paragraph" w:styleId="Metadata"><w:name w:val="Metadata"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/></w:pPr><w:rPr><w:color w:val="595959"/><w:sz w:val="${Math.max(9, size - 1) * 2}"/><w:szCs w:val="${Math.max(9, size - 1) * 2}"/></w:rPr></w:style></w:styles>`;
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let value = n;
  for (let bit = 0; bit < 8; bit++)
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  crcTable[n] = value >>> 0;
}
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** OPC parts use portable uncompressed ZIP entries with UTF-8 names and CRCs. */
function zip(parts: Array<[string, string]>, createdAt: string): Uint8Array {
  const entries: Array<{
    name: Uint8Array;
    data: Uint8Array;
    crc: number;
    offset: number;
  }> = [];
  let offset = 0;
  let centralSize = 0;
  const names = new Set<string>();
  if (!parts.length || parts.length > 0xffff) invalid("ZIP 条目数量无效。");
  for (const [path, text] of parts) {
    if (
      names.has(path) ||
      !/^[A-Za-z0-9_[\]./-]+$/.test(path) ||
      path.startsWith("/") ||
      path.split("/").some((s) => !s || s === ".." || s === ".")
    )
      invalid("ZIP 部件路径无效或重复。");
    names.add(path);
    const name = encoder.encode(path);
    const data = encoder.encode(text);
    if (name.length > 0xffff) invalid("ZIP 部件名称过长。");
    centralSize += 46 + name.length;
    const next = offset + 30 + name.length + data.length;
    if (
      !Number.isSafeInteger(next) ||
      next + centralSize + 22 > scriptDocxLimits.archiveBytes
    )
      invalid("文件过大，请拆分为较少集数导出。");
    entries.push({ name, data, crc: crc32(data), offset });
    offset = next;
  }
  const centralOffset = offset;
  const bytes = new Uint8Array(centralOffset + centralSize + 22);
  const view = new DataView(bytes.buffer);
  const date = new Date(createdAt);
  // UTC getters are deliberate: the same record has identical bytes in every zone.
  const year = Math.max(1980, Math.min(2107, date.getUTCFullYear()));
  const dosTime =
    (date.getUTCHours() << 11) |
    (date.getUTCMinutes() << 5) |
    (date.getUTCSeconds() >>> 1);
  const dosDate =
    ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  const u16 = (at: number, value: number) => view.setUint16(at, value, true);
  const u32 = (at: number, value: number) => view.setUint32(at, value, true);
  for (const entry of entries) {
    const at = entry.offset;
    u32(at, 0x04034b50);
    u16(at + 4, 20);
    u16(at + 6, 0x0800);
    u16(at + 8, 0);
    u16(at + 10, dosTime);
    u16(at + 12, dosDate);
    u32(at + 14, entry.crc);
    u32(at + 18, entry.data.length);
    u32(at + 22, entry.data.length);
    u16(at + 26, entry.name.length);
    u16(at + 28, 0);
    bytes.set(entry.name, at + 30);
    bytes.set(entry.data, at + 30 + entry.name.length);
    u32(offset, 0x02014b50);
    u16(offset + 4, 20);
    u16(offset + 6, 20);
    u16(offset + 8, 0x0800);
    u16(offset + 10, 0);
    u16(offset + 12, dosTime);
    u16(offset + 14, dosDate);
    u32(offset + 16, entry.crc);
    u32(offset + 20, entry.data.length);
    u32(offset + 24, entry.data.length);
    u16(offset + 28, entry.name.length);
    u16(offset + 30, 0);
    u16(offset + 32, 0);
    u16(offset + 34, 0);
    u16(offset + 36, 0);
    u32(offset + 38, 0);
    u32(offset + 42, entry.offset);
    bytes.set(entry.name, offset + 46);
    offset += 46 + entry.name.length;
  }
  u32(offset, 0x06054b50);
  u16(offset + 4, 0);
  u16(offset + 6, 0);
  u16(offset + 8, entries.length);
  u16(offset + 10, entries.length);
  u32(offset + 12, centralSize);
  u32(offset + 16, centralOffset);
  u16(offset + 20, 0);
  return bytes;
}

/**
 * Pure rendering of a persisted export receipt, not permission/approval admission.
 * The shared record-export command must authorize and pin it before calling here.
 * Never inspect current approvals, current draft revisions or current metadata:
 * unlocking/editing later must not silently rewrite a historical delivery.
 * No Node APIs, network, clock, randomness, external links or executable content.
 */
export function buildScriptDocx(
  production: ScriptProduction,
  exportId: string,
): Uint8Array {
  const matches = production.exports.filter((record) => record.id === exportId);
  if (matches.length !== 1) invalid("导出记录不存在或不唯一。");
  if (matches[0]!.items.length > scriptDocxLimits.items)
    invalid("导出条目数量过多。");
  const record = scriptProductionSchema.shape.exports.element.parse(matches[0]);
  const metadataVersions = production.metadataHistory.filter(
    (m) => m.revision === record.contextRevision,
  );
  if (metadataVersions.length !== 1) invalid("项目历史版本缺失或不唯一。");
  const metadata = scriptProductionSchema.shape.metadataHistory.element.parse(
    metadataVersions[0],
  );
  const productionId = scriptProductionSchema.shape.id.parse(production.id);
  const brief = scriptBriefSchema.parse(metadata.brief);
  const items = pinnedItems(production, record);
  const { template } = record;
  const document = new DocumentXml();
  document.add(`${declaration}<w:document xmlns:w="${wns}"><w:body>`);
  document.paragraph(metadata.title, "Title");
  document.paragraph(template.title, "Subtitle");
  document.field(
    "剧本项目 / 企划版本",
    `${productionId} / v${record.contextRevision}`,
  );
  document.field("导出记录", record.id);
  document.field("导出记录时间（ISO 8601）", record.createdAt);
  document.field(
    "导出人",
    `${record.createdBy.actantId}（${record.createdBy.principalId}）`,
  );
  document.field("本次交付", `${items.length} 个条目的指定历史版本`);
  document.field(
    "创作要求",
    `${brief.mode === "original" ? "原创" : "改编"}；计划 ${brief.episodeCount} 集，每集 ${brief.episodeSeconds} 秒`,
  );
  document.field("受众", brief.audience);
  document.field("题材", brief.genre);
  document.field("风格", brief.style);
  document.field("制作约束", brief.constraints);
  document.field("素材权利说明", brief.rightsStatement);

  const renderItem = (item: PinnedItem, pageBreak = false) => {
    const { draft } = item;
    const label =
      item.kind === "scene"
        ? template.sceneHeading
        : scriptKindLabels[item.kind];
    document.paragraph(
      `${label} · ${draft.title}`,
      item.kind === "scene" ? "Heading2" : "Heading1",
      pageBreak,
    );
    document.field("文稿来源", `${item.id} v${item.revision}`);
    document.field(
      "创作依据",
      { original: "原创", source: "原作资料", adaptation: "改编设定" }[
        draft.basis
      ],
    );
    document.field("场所", draft.location);
    document.field("故事时间", draft.storyTime);
    document.field(
      "出场角色",
      draft.characters
        .map(
          (id) =>
            `${id} v${draft.dependencies.find((r) => r.itemId === id)!.revision}`,
        )
        .join("、"),
    );
    document.lines(draft.text);
    if (template.includeNotes)
      document.field("制作说明", draft.productionNotes);
    if (template.includeContinuity) {
      document.field("观众已知", draft.audienceKnowledge);
      document.field("角色已知", draft.characterKnowledge);
      document.field("伏笔与兑现", draft.setupPayoff);
    }
    if (draft.dependencies.length)
      document.field(
        "依赖版本",
        draft.dependencies.map((r) => `${r.itemId} v${r.revision}`).join("；"),
      );
    for (const source of draft.sources) {
      document.field("原作引用", `${source.artifactId} v${source.revision}`);
      if (source.quote) document.field("原文", source.quote);
    }
  };
  // Supporting material is ordered by kind, then authored order and stable ID.
  for (const kind of ["source", "setting", "character", "outline"] as const)
    for (const item of items.filter((i) => i.kind === kind).sort(byOrder))
      renderItem(item);
  // Episode groups are stable even when export references or storage order differ.
  for (const episode of items
    .filter((i) => i.kind === "episode")
    .sort(byOrder)) {
    renderItem(episode, template.pageBreakEpisodes);
    for (const scene of items
      .filter((i) => i.kind === "scene" && i.draft.parentId === episode.id)
      .sort(byOrder))
      renderItem(scene);
  }
  document.add(
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>',
  );
  const date = new Date(record.createdAt).toISOString();
  const author = xml(
    `${record.createdBy.actantId} (${record.createdBy.principalId})`,
  );
  return zip(
    [
      [
        "[Content_Types].xml",
        `${declaration}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
      ],
      [
        "_rels/.rels",
        `${declaration}<Relationships xmlns="${relns}"><Relationship Id="rIdDocument" Type="${officeRelns}/officeDocument" Target="word/document.xml"/><Relationship Id="rIdCore" Type="${relns}/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rIdApp" Type="${officeRelns}/extended-properties" Target="docProps/app.xml"/></Relationships>`,
      ],
      ["word/document.xml", document.finish()],
      ["word/styles.xml", styles(template.font, template.fontSize)],
      [
        "word/_rels/document.xml.rels",
        `${declaration}<Relationships xmlns="${relns}"><Relationship Id="rIdStyles" Type="${officeRelns}/styles" Target="styles.xml"/></Relationships>`,
      ],
      [
        "docProps/core.xml",
        `${declaration}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(metadata.title)}</dc:title><dc:subject>${xml(template.title)}</dc:subject><dc:creator>${author}</dc:creator><dc:identifier>${xml(record.id)}</dc:identifier><dc:description>${xml(`${productionId} / v${record.contextRevision}`)}</dc:description><cp:lastModifiedBy>${author}</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${date}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${date}</dcterms:modified></cp:coreProperties>`,
      ],
      [
        "docProps/app.xml",
        `${declaration}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Morphz Script Studio</Application></Properties>`,
      ],
    ],
    record.createdAt,
  );
}
