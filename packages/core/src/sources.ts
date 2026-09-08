/** Shared selection policy; the center enforces it again after upload. */
const excludedDirectories = new Set([
  "node_modules",
  "dist",
  "build",
  "target",
  "coverage",
  "vendor",
  "test-results",
  "playwright-report",
  "__pycache__",
]);
const sensitiveNames =
  /^(?:credentials?|secrets?|tokens?|passwords?|id_rsa|id_ed25519)(?:[._-]|$)/i;
// Object storage guard, independent of speech transport chunking.
export const maxDocumentCharacters = 2_000_000;
export const maxDocumentBytes = 8 * 1024 * 1024;
export const maxImportFiles = 100;

export function documentImportIssue(path: string): string | null {
  if (
    !path ||
    path.length > 1000 ||
    /[\\\x00-\x1f\x7f:]/.test(path) ||
    path.startsWith("/")
  )
    return "请选择有效的相对文件路径。";
  const parts = path.split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part.startsWith(".") ||
        excludedDirectories.has(part.toLowerCase()),
    )
  )
    return "隐藏文件、依赖目录和构建产物不作为资料导入。";
  const name = parts.at(-1)!;
  if (sensitiveNames.test(name)) return "凭据文件不作为资料导入。";
  if (!/\.(md|markdown|txt)$/i.test(name))
    return "目前资料导入支持 Markdown 和纯文本。";
  return null;
}

export function documentTextIssue(text: string): string | null {
  if (text.includes("\0")) return "文件含有二进制内容，请选择 UTF-8 文本。";
  if (/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(text))
    return "文件包含私钥，不能作为资料导入。";
  if (
    text.length > maxDocumentCharacters ||
    new TextEncoder().encode(text).byteLength > maxDocumentBytes
  )
    return "单篇资料不能超过 8 MB 或 200 万字符，请按卷拆分更大的资料。";
  return null;
}
