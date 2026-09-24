import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { DomainError } from "../../../packages/core/src/model.js";
import {
  maxPdfBytes,
  maxPdfPages,
  pdfContentSchema,
} from "../../../packages/core/src/pdf.js";

const parser = import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs");
const assetRoot = resolve(dirname(fileURLToPath(parser)), "../..");
// No document JavaScript, external URLs, host paths from the file, or arbitrary module imports.
// A separate heap and deadline contain malformed/computationally expensive documents.
const source = `
const {parentPort, workerData} = require('node:worker_threads');
(async () => {
  const {getDocument} = await import(workerData.parser);
  let task;
  try {
    task = getDocument({data: new Uint8Array(workerData.bytes),
      useSystemFonts: false, stopAtErrors: true, disableFontFace: true,
      cMapUrl: workerData.assetRoot + '/cmaps/', cMapPacked: true,
      standardFontDataUrl: workerData.assetRoot + '/standard_fonts/',
      wasmUrl: workerData.assetRoot + '/wasm/', verbosity: 0});
    const pdf = await task.promise;
    if (pdf.numPages > workerData.maxPages) throw new Error('page_limit');
    const pages = []; let size = 0;
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const data = await page.getTextContent();
      const text = data.items.filter(x => typeof x.str === 'string')
        .map(x => x.str + (x.hasEOL ? '\\n' : '')).join('');
      size += text.length;
      if (size > 500000) throw new Error('text_limit');
      pages.push(text); page.cleanup();
    }
    parentPort.postMessage({pages});
  } catch (e) {
    parentPort.postMessage({error: e.name === 'PasswordException' ? 'password' :
      ['page_limit','text_limit'].includes(e.message) ? e.message : 'invalid'});
  } finally { if (task) await task.destroy(); }
})().catch(() => parentPort.postMessage({error:'invalid'}));`;

let active = false;
export async function extractPdf(bytes: Buffer): Promise<string[]> {
  if (
    !bytes.length ||
    bytes.length > maxPdfBytes ||
    bytes.subarray(0, 5).toString() !== "%PDF-"
  )
    throw new DomainError(
      "invalid",
      `请选择有效 PDF，文件不能超过 ${maxPdfBytes / 1024 / 1024} MB。`,
    );
  if (active)
    throw new DomainError("conflict", "正在处理另一份 PDF，请稍后重试。");
  active = true;
  try {
    return await new Promise<string[]>((accept, reject) => {
      const worker = new Worker(source, {
        eval: true,
        workerData: { bytes, parser, assetRoot, maxPages: maxPdfPages },
        resourceLimits: {
          maxOldGenerationSizeMb: 192,
          maxYoungGenerationSizeMb: 32,
        },
        stdout: true,
        stderr: true,
      });
      // Parser diagnostics can contain document text. Discard, do not send to shared logs.
      worker.stdout?.resume();
      worker.stderr?.resume();
      const timer = setTimeout(() => {
        reject(new DomainError("invalid", "PDF 解析超时，请缩小文件后重试。"));
        void worker.terminate();
      }, 20_000);
      worker.on("message", (message) => {
        const parsed = pdfContentSchema.shape.pages.safeParse(message.pages);
        if (parsed.success) accept(parsed.data);
        else
          reject(
            new DomainError(
              "invalid",
              message.error === "password"
                ? "暂不支持加密 PDF，请先在本机解密再导入。"
                : message.error === "page_limit"
                  ? "PDF 不能超过 300 页。"
                  : message.error === "text_limit"
                    ? "PDF 可提取文字超过 50 万字，请拆分后导入。"
                    : "PDF 无法解析，未创建资料对象。",
            ),
          );
        void worker.terminate();
      });
      worker.on("error", () =>
        reject(new DomainError("invalid", "PDF 解析失败，未创建资料对象。")),
      );
      worker.on("exit", () => {
        clearTimeout(timer);
        reject(new DomainError("invalid", "PDF 解析已中断。"));
      });
    });
  } finally {
    active = false;
  }
}
