import { createHash } from "node:crypto";
import { posix } from "node:path";
import { Worker } from "node:worker_threads";
import { execFileSync } from "node:child_process";
import { DOMParser } from "@xmldom/xmldom";
import { fromBuffer, type Entry, type ZipFile } from "yauzl";
import mammoth from "mammoth";
import sanitizeHtml from "sanitize-html";
import {
  parse,
  parseFragment,
  serialize,
  type DefaultTreeAdapterMap,
} from "parse5";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { toHast } from "mdast-util-to-hast";
import { toHtml } from "hast-util-to-html";
import { DomainError } from "../../core/src/model.js";
import {
  maxReadingFileBytes,
  maxReadingCharacters,
  publicationSchema,
  type ParsedPublication,
  type ReaderSection,
  type Publication,
} from "../../core/src/reader.js";

const maxEntryBytes = 16 * 1024 * 1024;
const maxExpandedBytes = 128 * 1024 * 1024;
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
type HtmlNode = DefaultTreeAdapterMap["node"];
function htmlText(node: HtmlNode): string {
  if (node.nodeName === "#text")
    return (node as DefaultTreeAdapterMap["textNode"]).value;
  return "childNodes" in node ? node.childNodes.map(htmlText).join("") : "";
}
function separateBlocks(node: HtmlNode) {
  if (!("childNodes" in node)) return;
  for (let index = 0; index < node.childNodes.length; index++) {
    const child = node.childNodes[index]!;
    separateBlocks(child);
    if (
      /^(p|div|section|article|h[1-6]|br|hr|blockquote|pre|ul|ol|li|table|tr)$/.test(
        child.nodeName,
      )
    ) {
      const next = node.childNodes[index + 1];
      if (
        !next ||
        next.nodeName !== "#text" ||
        !(next as DefaultTreeAdapterMap["textNode"]).value.startsWith("\n")
      ) {
        node.childNodes.splice(++index, 0, {
          nodeName: "#text",
          value: "\n",
          parentNode: node,
        });
      }
    }
  }
}

/** One canonical inert DOM: the browser's Range offsets and the Agent's text match. */
export function safeReadingSection(
  id: string,
  title: string,
  html: string,
): ReaderSection {
  if (html.length > 4_000_000)
    throw new DomainError("invalid", "单章内容过大，请拆分后导入。");
  const clean = sanitizeHtml(html, {
    allowedTags: [
      "p",
      "div",
      "section",
      "article",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "strong",
      "em",
      "b",
      "i",
      "u",
      "s",
      "sub",
      "sup",
      "ruby",
      "rt",
      "rp",
      "br",
      "hr",
      "blockquote",
      "pre",
      "code",
      "ul",
      "ol",
      "li",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "caption",
      "a",
      "img",
      "span",
    ],
    allowedAttributes: {
      a: ["href", "id"],
      img: ["src", "alt", "width", "height"],
      "*": ["id"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan"],
    },
    allowedSchemes: [],
    allowedSchemesByTag: { img: ["data"] },
    allowProtocolRelative: false,
    nonTextTags: [
      "style",
      "script",
      "textarea",
      "option",
      "iframe",
      "object",
      "embed",
      "svg",
      "math",
      "form",
    ],
    transformTags: {
      a: (_name, attrs): sanitizeHtml.Tag => ({
        tagName: "a",
        attribs: {
          ...(attrs.id ? { id: attrs.id } : {}),
          ...(attrs.href?.startsWith("#") ? { href: attrs.href } : {}),
        },
      }),
      img: (_name, attrs): sanitizeHtml.Tag =>
        /^data:image\/(png|jpeg|gif|webp);base64,[a-z\d+/=]+$/i.test(
          attrs.src ?? "",
        ) && (attrs.src?.length ?? 0) < 2_000_000
          ? {
              tagName: "img",
              attribs: {
                src: attrs.src!,
                alt: (attrs.alt ?? "").slice(0, 500),
              },
            }
          : {
              tagName: "span",
              attribs: {},
              text: attrs.alt
                ? `[图片：${attrs.alt.slice(0, 500)}]`
                : "[图片未载入]",
            },
    },
  });
  const dom = parseFragment(clean);
  separateBlocks(dom);
  const text = htmlText(dom);
  if (text.length > 1_000_000)
    throw new DomainError("invalid", "单章文字超过 100 万字，请拆分后导入。");
  return {
    id,
    title: title.trim().slice(0, 180) || "正文",
    html: serialize(dom),
    text,
  };
}

export function markdownSections(markdown: string): ReaderSection[] {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
  // Resolve definitions/footnotes against the complete AST before splitting.
  // Rendering each chapter independently silently loses cross-chapter notes.
  return splitHtml(toHtml(toHast(tree)!));
}

function decode(bytes: Buffer) {
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe)
      return new TextDecoder("utf-16le", { fatal: true }).decode(bytes);
    if (bytes[0] === 0xfe && bytes[1] === 0xff)
      return new TextDecoder("utf-16be", { fatal: true }).decode(bytes);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new DomainError(
      "invalid",
      "文字编码无法读取，请以 UTF-8 或 UTF-16 重新保存。",
    );
  }
}
function xml(bytes: Buffer) {
  const source = decode(bytes);
  if (/<!ENTITY/i.test(source))
    throw new DomainError("invalid", "文档包含不安全的 XML 实体。");
  const doc = new DOMParser({
    onError: (level) => {
      if (level !== "warning") throw new Error("Invalid XML");
    },
  }).parseFromString(source, "application/xml");
  return doc;
}
const elements = (doc: ReturnType<typeof xml>, local: string) =>
  Array.from(doc.getElementsByTagNameNS("*", local));
function archivePath(base: string, relative: string) {
  const path = decodeURIComponent(relative.split("#")[0]!);
  if (!path || /[\\\0?]|^[a-z]+:|^\//i.test(path))
    throw new DomainError("invalid", "电子书资源路径无效。");
  const resolved = posix.normalize(posix.join(posix.dirname(base), path));
  if (resolved === ".." || resolved.startsWith("../"))
    throw new DomainError("invalid", "电子书资源不能越出书籍目录。");
  return resolved;
}

/** No extraction to disk. Validate central directory before opening any member. */
async function openArchive(bytes: Buffer) {
  const zip = await new Promise<ZipFile>((resolve, reject) =>
    fromBuffer(
      bytes,
      {
        lazyEntries: true,
        autoClose: false,
        strictFileNames: true,
        validateEntrySizes: true,
      },
      (err, file) => (err || !file ? reject(err) : resolve(file)),
    ),
  );
  const entries = new Map<string, Entry>();
  try {
    await new Promise<void>((resolve, reject) => {
      let expanded = 0;
      zip
        .on("error", reject)
        .on("end", resolve)
        .on("entry", (entry: Entry) => {
          expanded += entry.uncompressedSize;
          if (
            entries.size >= 5000 ||
            expanded > maxExpandedBytes ||
            entry.uncompressedSize > maxEntryBytes ||
            entry.isEncrypted() ||
            entries.has(entry.fileName) ||
            ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000
          ) {
            reject(new Error("Unsafe or oversized archive"));
            return;
          }
          entries.set(entry.fileName, entry);
          zip.readEntry();
        });
      zip.readEntry();
    });
  } catch (e) {
    zip.close();
    throw e;
  }
  const read = async (name: string) => {
    const entry = entries.get(name);
    if (!entry) throw new DomainError("invalid", "电子书缺少引用的文件。");
    const stream = await new Promise<import("node:stream").Readable>(
      (resolve, reject) =>
        zip.openReadStream(entry, (err, s) =>
          err || !s ? reject(err) : resolve(s),
        ),
    );
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > maxEntryBytes || size > entry.uncompressedSize) {
        stream.destroy();
        throw new Error("Oversized archive member");
      }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  };
  return { entries, read, close: () => zip.close() };
}

function splitHtml(html: string): ReaderSection[] {
  const dom = parseFragment(html),
    groups: HtmlNode[][] = [];
  let nodes: HtmlNode[] = [],
    size = 0;
  for (const node of dom.childNodes) {
    if (nodes.length && (/^h[12]$/.test(node.nodeName) || size > 12000)) {
      groups.push(nodes);
      nodes = [];
      size = 0;
    }
    nodes.push(node);
    size += htmlText(node).length;
  }
  if (nodes.length) groups.push(nodes);
  const sections = (groups.length ? groups : [[]])
    .map((group, index) => {
      const fragment = parseFragment("");
      fragment.childNodes = group as typeof fragment.childNodes;
      const heading = group.find((n) => /^h[1-6]$/.test(n.nodeName));
      return safeReadingSection(
        `section-${index + 1}`,
        heading ? htmlText(heading) : index ? `正文 ${index + 1}` : "正文",
        serialize(fragment),
      );
    })
    .filter((section) => section.text.trim() || /<img\s/i.test(section.html))
    .map((section, index) => ({ ...section, id: `section-${index + 1}` }));
  const fragments = sections.map((section) => parseFragment(section.html));
  const targets = new Map<string, string>();
  const visit = (
    node: HtmlNode,
    fn: (node: DefaultTreeAdapterMap["element"]) => void,
  ) => {
    if ("tagName" in node) fn(node);
    if ("childNodes" in node)
      node.childNodes.forEach((child) => visit(child, fn));
  };
  fragments.forEach((fragment, index) =>
    visit(fragment, (node) => {
      const id = node.attrs.find((a) => a.name === "id")?.value;
      if (id && !targets.has(id)) targets.set(id, sections[index]!.id);
    }),
  );
  fragments.forEach((fragment, index) => {
    visit(fragment, (node) => {
      const href =
        node.tagName === "a" && node.attrs.find((a) => a.name === "href");
      if (!href || !href.value.startsWith("#")) return;
      let id: string;
      try {
        id = decodeURIComponent(href.value.slice(1));
      } catch {
        return;
      }
      const target = targets.get(id);
      if (target) href.value = `#reader:${target}:${encodeURIComponent(id)}`;
    });
    sections[index]!.html = serialize(fragment);
  });
  return sections;
}

/** Run only inside the bounded import Worker (also exported for parser unit tests). */
export async function parsePublicationRaw(
  name: string,
  input: Uint8Array,
): Promise<ParsedPublication> {
  const bytes = Buffer.from(input),
    extension = name.split(".").at(-1)!.toLowerCase();
  if (!bytes.length || bytes.length > maxReadingFileBytes)
    throw new DomainError("invalid", "读物不能为空或超过 32 MB。");
  let title = name.replace(/\.[^.]+$/, "").slice(0, 180),
    author = "",
    language = "",
    edition = "";
  let format: Publication["format"], sections: ReaderSection[];
  if (extension === "epub") {
    format = "epub";
    const archive = await openArchive(bytes);
    try {
      if (
        (await archive.read("mimetype")).toString().trim() !==
        "application/epub+zip"
      )
        throw new Error("Invalid EPUB type");
      const container = xml(await archive.read("META-INF/container.xml"));
      const rootfile =
        elements(container, "rootfile").find(
          (e) =>
            e.getAttribute("media-type") === "application/oebps-package+xml",
        ) ?? elements(container, "rootfile")[0];
      const packagePath = archivePath(
        "container",
        rootfile?.getAttribute("full-path") ?? "",
      );
      const pkg = xml(await archive.read(packagePath));
      title =
        elements(pkg, "title")[0]?.textContent?.trim().slice(0, 180) || title;
      author = elements(pkg, "creator")
        .map((e) => e.textContent)
        .join("、")
        .slice(0, 1000);
      language = (elements(pkg, "language")[0]?.textContent ?? "").slice(0, 80);
      edition = (elements(pkg, "identifier")[0]?.textContent ?? "").slice(
        0,
        500,
      );
      const items = new Map(
        elements(pkg, "item").map((e) => [e.getAttribute("id"), e]),
      );
      const spine = elements(pkg, "itemref").filter(
        (e) => e.getAttribute("linear") !== "no",
      );
      if (!spine.length || spine.length > 2000)
        throw new Error("Invalid EPUB spine");
      const labels = new Map<string, string>();
      const nav = [...items.values()].find((e) =>
        e.getAttribute("properties")?.split(/\s+/).includes("nav"),
      );
      if (nav) {
        const navPath = archivePath(
          packagePath,
          nav.getAttribute("href") ?? "",
        );
        for (const a of elements(xml(await archive.read(navPath)), "a")) {
          const href = a.getAttribute("href");
          if (href && !/^[a-z]+:/i.test(href)) {
            const path = archivePath(navPath, href);
            if (!labels.has(path))
              labels.set(path, a.textContent?.trim().slice(0, 180) ?? "");
          }
        }
      }
      const ncx = [...items.values()].find(
        (e) => e.getAttribute("media-type") === "application/x-dtbncx+xml",
      );
      if (!nav && ncx) {
        const ncxPath = archivePath(
          packagePath,
          ncx.getAttribute("href") ?? "",
        );
        for (const point of elements(
          xml(await archive.read(ncxPath)),
          "navPoint",
        )) {
          const src = point
            .getElementsByTagNameNS("*", "content")[0]
            ?.getAttribute("src");
          const label = point
            .getElementsByTagNameNS("*", "navLabel")[0]
            ?.textContent?.trim();
          if (src && label) {
            const path = archivePath(ncxPath, src);
            if (!labels.has(path)) labels.set(path, label.slice(0, 180));
          }
        }
      }
      const sectionPaths = new Map(
        spine.map((ref, index) => [
          archivePath(
            packagePath,
            items.get(ref.getAttribute("idref"))?.getAttribute("href") ?? "",
          ),
          `section-${index + 1}`,
        ]),
      );
      const encrypted = archive.entries.has("META-INF/encryption.xml")
        ? elements(
            xml(await archive.read("META-INF/encryption.xml")),
            "CipherReference",
          ).map((e) => e.getAttribute("URI"))
        : [];
      sections = [];
      let total = 0,
        imageBytes = 0;
      for (const [index, ref] of spine.entries()) {
        const item = items.get(ref.getAttribute("idref"));
        if (
          !item ||
          !["application/xhtml+xml", "text/html"].includes(
            item.getAttribute("media-type") ?? "",
          )
        )
          throw new Error("Unsupported EPUB spine item");
        const path = archivePath(packagePath, item.getAttribute("href") ?? "");
        if (encrypted.includes(path))
          throw new DomainError(
            "invalid",
            "这本 EPUB 的正文已加密，暂不能读取 DRM 书籍。",
          );
        const chapter = xml(await archive.read(path));
        for (const a of elements(chapter, "a")) {
          const href = a.getAttribute("href") ?? "";
          if (!href || href.startsWith("#")) continue;
          a.removeAttribute("href");
          if (/^[a-z]+:|^\//i.test(href)) continue;
          const target = sectionPaths.get(archivePath(path, href));
          if (target)
            a.setAttribute(
              "href",
              `#reader:${target}:${encodeURIComponent(href.split("#")[1] ?? "")}`,
            );
        }
        for (const image of elements(chapter, "img")) {
          const src = image.getAttribute("src") ?? "";
          image.removeAttribute("src");
          if (!src || /^[a-z]+:|^\//i.test(src)) continue;
          const imagePath = archivePath(path, src),
            ext = imagePath.split(".").at(-1)?.toLowerCase();
          const mime =
            ext &&
            (
              {
                png: "image/png",
                jpg: "image/jpeg",
                jpeg: "image/jpeg",
                gif: "image/gif",
                webp: "image/webp",
              } as Record<string, string>
            )[ext];
          const entry = archive.entries.get(imagePath);
          if (
            !mime ||
            !entry ||
            entry.uncompressedSize > 1_000_000 ||
            imageBytes + entry.uncompressedSize > 12_000_000
          )
            continue;
          const data = await archive.read(imagePath);
          imageBytes += data.length;
          image.setAttribute(
            "src",
            `data:${mime};base64,${data.toString("base64")}`,
          );
        }
        const body = elements(chapter, "body")[0];
        if (!body) throw new Error("Missing EPUB chapter body");
        const heading =
          elements(chapter, "h1")[0] ?? elements(chapter, "h2")[0];
        const section = safeReadingSection(
          `section-${index + 1}`,
          labels.get(path) || heading?.textContent || `章节 ${index + 1}`,
          body.toString(),
        );
        total += section.text.length;
        if (total > maxReadingCharacters) throw new Error("Book text limit");
        sections.push(section);
      }
    } finally {
      archive.close();
    }
  } else if (extension === "docx") {
    format = "docx";
    // Mammoth also reads ZIP; preflight all entries and reject entity definitions first.
    const archive = await openArchive(bytes);
    try {
      for (const path of archive.entries.keys())
        if (/\.xml$/i.test(path)) xml(await archive.read(path));
    } finally {
      archive.close();
    }
    const result = await mammoth.convertToHtml(
      { buffer: bytes },
      { externalFileAccess: false, includeEmbeddedStyleMap: false },
    );
    if (result.messages.some((m) => m.type === "error"))
      throw new Error("DOCX could not be read completely");
    sections = splitHtml(result.value);
  } else if (["md", "markdown"].includes(extension)) {
    format = "markdown";
    sections = markdownSections(decode(bytes));
  } else if (extension === "txt") {
    format = "text";
    const text = decode(bytes).replace(/\r\n?/g, "\n");
    const paragraphs = text.split(/\n{2,}/);
    sections = splitHtml(
      paragraphs.map((p) => `<p>${escape(p)}</p>\n\n`).join(""),
    );
  } else if (["html", "htm"].includes(extension)) {
    format = "html";
    // Parse a document, not a fragment: head/title metadata must not become
    // a spurious first chapter before the actual body. Fragments get an
    // implicit body through the same HTML parser.
    const document = parse(decode(bytes));
    const root = document.childNodes.find((node) => node.nodeName === "html");
    const body =
      root && "childNodes" in root
        ? root.childNodes.find((node) => node.nodeName === "body")
        : undefined;
    // Each section is sanitized below. A default first sanitization would strip
    // safe IDs and embedded images before the reader can preserve them.
    sections = splitHtml(body && "childNodes" in body ? serialize(body) : "");
  } else if (extension === "doc" || extension === "rtf") {
    if (process.platform !== "darwin")
      throw new DomainError(
        "invalid",
        "当前主机没有旧版 Word / RTF 转换器，请另存为 DOCX、PDF 或 TXT 后导入；原文件不会被修改。",
      );
    const valid =
      extension === "doc"
        ? bytes.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex"))
        : /^\{\\rtf\d/.test(bytes.subarray(0, 12).toString("ascii"));
    if (!valid)
      throw new DomainError(
        "invalid",
        "文件内容与 Word / RTF 格式不符，请检查原文件。",
      );
    let text: string;
    try {
      // This runs inside the bounded import worker. No shell, original path,
      // attachments or credentials are passed to the OS converter. Only text
      // is retained; linked resources and macros are never requested.
      text = execFileSync(
        "/usr/bin/textutil",
        [
          "-stdin",
          "-stdout",
          "-format",
          extension,
          "-convert",
          "txt",
          "-encoding",
          "UTF-8",
          "-noload",
          "-nostore",
          "-strip",
        ],
        {
          input: bytes,
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
          timeout: 12000,
          env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
        },
      );
    } catch {
      throw new DomainError(
        "invalid",
        "Word / RTF 文字转换失败或超时，请另存为 DOCX 或 PDF；原文件未被修改。",
      );
    }
    format = extension;
    sections = splitHtml(
      text
        .replace(/\r\n?/g, "\n")
        .split(/\n{2,}/)
        .map((p) => `<p>${escape(p)}</p>\n\n`)
        .join(""),
    );
  } else
    throw new DomainError(
      "invalid",
      "支持 EPUB、PDF、Markdown、TXT、DOCX 和 HTML；macOS 还支持 DOC / RTF 文字阅读。",
    );
  if (!sections.some((s) => s.text.trim() || /<img\s/i.test(s.html)))
    throw new DomainError("invalid", "这份文件没有可读取的正文。");
  const content = publicationSchema.parse({
    kind: "publication",
    assetId: createHash("sha256").update(bytes).digest("hex"),
    format,
    author,
    language,
    edition,
    sections: sections.map((s) => ({
      id: s.id,
      title: s.title,
      characters: s.text.length,
    })),
  });
  return { title: title || "未命名读物", content, sections };
}

let activeImports = 0;
export async function parsePublication(
  name: string,
  bytes: Buffer,
): Promise<ParsedPublication> {
  if (!bytes.length || bytes.length > maxReadingFileBytes)
    throw new DomainError("invalid", "读物不能为空或超过 32 MB。");
  if (activeImports >= 2)
    throw new DomainError("conflict", "正在导入其他读物，请稍后重试。");
  activeImports++;
  try {
    return await new Promise<ParsedPublication>((resolve, reject) => {
      const dev = import.meta.url.endsWith(".ts");
      const worker = new Worker(
        `const {parentPort,workerData:d}=require('node:worker_threads');
        (async()=>{try { const m=d.dev ? await (await import(d.tsx)).tsImport(d.module,d.module) : await import(d.module);
          parentPort.postMessage({ok:true,value:await m.parsePublicationRaw(d.name,d.bytes)});
        } catch(e){parentPort.postMessage({ok:false,message:e.code==='invalid'?e.message:'文件无法安全解析，请检查格式或文件是否损坏。'});}})();`,
        {
          eval: true,
          execArgv: [],
          workerData: {
            dev,
            ...(dev ? { tsx: import.meta.resolve("tsx/esm/api") } : {}),
            module: import.meta.url,
            name,
            bytes,
          },
          resourceLimits: {
            maxOldGenerationSizeMb: 256,
            maxYoungGenerationSizeMb: 32,
          },
          stdout: true,
          stderr: true,
        },
      );
      worker.stdout.resume();
      worker.stderr.resume();
      const timer = setTimeout(() => {
        reject(new DomainError("invalid", "读物解析超时，请拆分后重试。"));
        void worker.terminate();
      }, 25000);
      worker.on("message", (r) => {
        clearTimeout(timer);
        if (r.ok) resolve(r.value);
        else reject(new DomainError("invalid", r.message));
        void worker.terminate();
      });
      worker.on("error", () =>
        reject(new DomainError("invalid", "读物解析失败，原文件未被修改。")),
      );
      worker.on("exit", () => {
        clearTimeout(timer);
        reject(new DomainError("invalid", "读物解析已中断。"));
      });
    });
  } finally {
    activeImports--;
  }
}
