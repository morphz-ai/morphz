// Synthetic input files for original-window acceptance. Nothing from the user's library.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { execFileSync } from "node:child_process";
function zip(files) {
  const local = [],
    central = [];
  let offset = 0;
  for (const [path, text] of Object.entries(files)) {
    const name = Buffer.from(path),
      bytes = Buffer.from(text),
      crc = crc32(bytes),
      header = Buffer.alloc(30),
      entry = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(bytes.length, 20);
    entry.writeUInt32LE(bytes.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    local.push(header, name, bytes);
    central.push(entry, name);
    offset += header.length + name.length + bytes.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(
    central.reduce((n, b) => n + b.length, 0),
    12,
  );
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}
const directory = mkdtempSync(join(tmpdir(), "morphz-reader-acceptance-"));
const title = "TEST 伴读体验验收 0923";
const epub = zip({
  mimetype: "application/epub+zip",
  "META-INF/container.xml":
    '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  "book.opf": `<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title><dc:creator>Morphz 合成测试</dc:creator><dc:language>zh</dc:language></metadata><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>`,
  "nav.xhtml":
    '<html xmlns="http://www.w3.org/1999/xhtml"><body><nav><a href="one.xhtml">第一章 · 阅读与理解</a><a href="two.xhtml">第二章 · 回到原文</a></nav></body></html>',
  "one.xhtml":
    '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>阅读与理解</h1><p>这是一份合成验收材料，不是真实古籍。以下短句只用于测试阅读、划线和提问。</p><p>兼听则明，偏信则暗。</p><p>先读原文，再给出自己的判断。</p><p><a href="two.xhtml#note">查看第二章注释</a></p>' +
    Array.from(
      { length: 24 },
      (_, i) =>
        `<p>第 ${i + 1} 段：阅读留下的问题，比急于接受结论更值得保存。这里用于验证滚动、定位和恢复。</p>`,
    ).join("") +
    "</body></html>",
  "two.xhtml":
    '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>回到原文</h1><p id="note">测试注释：这条引用应准确回到第二章的位置。</p><p>同一个 Morphz，可以接续阅读时的讨论，不必另找一个助手。</p><a href="one.xhtml">返回第一章</a></body></html>',
});
writeFileSync(join(directory, "TEST-阅读验收.epub"), epub);
writeFileSync(
  join(directory, "TEST-阅读验收.md"),
  "# 阅读验收\n\n这是 Markdown 合成资料。\n\n|功能|检查|\n|---|---|\n|表格|应可阅读|\n\n## 第二节\n\n支持目录定位。\n",
);
writeFileSync(
  join(directory, "TEST-阅读验收.txt"),
  "这是纯文本合成资料。\n\n选中文字后，可以高亮、批注或向 Morphz 提问。",
);
writeFileSync(
  join(directory, "TEST-阅读验收.docx"),
  zip({
    "[Content_Types].xml":
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels":
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml":
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Word 伴读验收</w:t></w:r></w:p><w:p><w:r><w:t>这是合成 DOCX，不含个人资料。请验证选文和批注。</w:t></w:r></w:p></w:body></w:document>',
  }),
);
writeFileSync(
  join(directory, "TEST-网页阅读验收.html"),
  '<!doctype html><html lang="zh"><meta charset="utf-8"><title>TEST HTML 阅读验收</title><body><h1>HTML 阅读验收</h1><p>这是合成网页资料。</p><p><a href="#second">前往第二节</a></p><h2 id="second">第二节</h2><p>内部链接应定位到这段原文。</p></body></html>',
);
writeFileSync(
  join(directory, "TEST-RTF阅读验收.rtf"),
  "{\\rtf1\\ansi TEST RTF reading acceptance.\\par Select text, highlight and return to the original source.}",
);
if (process.platform === "darwin") {
  execFileSync("/usr/bin/textutil", [
    "-convert",
    "doc",
    "-output",
    join(directory, "TEST-DOC阅读验收.doc"),
    join(directory, "TEST-RTF阅读验收.rtf"),
  ]);
}
console.log(directory);
