import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { release } from "node:os";
import { DomainError } from "../../core/src/model.js";

const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const versions = new Map<string, string>();
function dependencyVersion(name: string) {
  const cached = versions.get(name);
  if (cached) return cached;
  let directory = dirname(fileURLToPath(import.meta.resolve(name)));
  for (;;) {
    try {
      const metadata = JSON.parse(
        readFileSync(join(directory, "package.json"), "utf8"),
      );
      if (metadata.name === name && typeof metadata.version === "string") {
        versions.set(name, metadata.version);
        return metadata.version as string;
      }
    } catch {
      /* A module entry can be nested below the package root. */
    }
    const parent = dirname(directory);
    if (parent === directory)
      throw new Error(`阅读解析器依赖缺少版本：${name}`);
    directory = parent;
  }
}
const fingerprints = new Map<string, string>();
function dependencyGraphDigest() {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      const metadata = JSON.parse(
        readFileSync(join(directory, "package.json"), "utf8"),
      );
      if (metadata.name === "morphz-application")
        return digest(readFileSync(join(directory, "package-lock.json")));
    } catch (error) {
      // Only absent package roots are skipped. A located installation without
      // its reproducible dependency graph cannot assert cache equivalence.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error("阅读解析器缺少已安装依赖图。");
    directory = parent;
  }
}
/** Host-owned fingerprint of the actual extraction Worker, canonical safety
 * transforms and installed dependency versions, not a Client supplied label.
 * PDF import extraction is deliberately distinct from the browser PDF viewer.
 * Compiled and development modules may safely produce different cache keys.
 */
export function readerParserIdentity(name: string) {
  const extension = name.split(".").at(-1)!.toLowerCase();
  const format = (
    {
      epub: "epub",
      pdf: "pdf",
      docx: "docx",
      doc: "doc",
      rtf: "rtf",
      html: "html",
      htm: "html",
      md: "markdown",
      markdown: "markdown",
      txt: "text",
    } as Record<string, string>
  )[extension];
  if (!format)
    throw new DomainError(
      "invalid",
      "请选择 EPUB、PDF、Word、Markdown 或文本读物。",
    );
  const family =
    format === "pdf"
      ? "pdf-import"
      : format === "doc" || format === "rtf"
        ? "textutil-import"
        : "publication-import";
  let parserVersion = fingerprints.get(family);
  if (!parserVersion) {
    const suffix = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const modules = [
      new URL(`./reader-import.${suffix}`, import.meta.url),
      new URL(`./reader-service.${suffix}`, import.meta.url),
      new URL(`../../core/src/reader.${suffix}`, import.meta.url),
      new URL(`./reader-parser-identity.${suffix}`, import.meta.url),
      ...(format === "pdf"
        ? [
            new URL(`./pdf.${suffix}`, import.meta.url),
            new URL(`../../core/src/pdf.${suffix}`, import.meta.url),
          ]
        : []),
    ];
    const dependencies = [
      "sanitize-html",
      "parse5",
      "zod",
      ...(format === "pdf"
        ? ["pdfjs-dist"]
        : [
            "@xmldom/xmldom",
            "yauzl",
            "mammoth",
            "unified",
            "remark-parse",
            "remark-gfm",
            "mdast-util-to-hast",
            "hast-util-to-html",
          ]),
    ];
    const native =
      family === "textutil-import"
        ? {
            platform: process.platform,
            release: release(),
            converter:
              process.platform === "darwin"
                ? digest(readFileSync("/usr/bin/textutil"))
                : "unavailable",
          }
        : null;
    parserVersion = `reader-parse-v2:${family}:${digest(
      JSON.stringify({
        modules: modules.map((url) => digest(readFileSync(url))),
        dependencies: dependencies.map((name) => [
          name,
          dependencyVersion(name),
        ]),
        dependencyGraph: dependencyGraphDigest(),
        runtime: { node: process.versions.node },
        native,
      }),
    )}`;
    fingerprints.set(family, parserVersion);
  }
  // Filename affects fallback title and format; no caller-controlled parser key.
  return {
    format,
    parserVersion,
    optionsSha256: digest(JSON.stringify({ name })),
  };
}
