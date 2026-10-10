import { z } from "zod";
import { DomainError } from "./model.js";
import { maxDocumentCharacters } from "./sources.js";

export const maxDocumentEditCharacters = 500_000;

/** Same exact replacement vocabulary as Runtime's file edit, but the target
 * remains an authorized, immutable Objects version, never a filesystem path. */
export const documentEditSchema = z
  .object({
    old_text: z.string().min(1).max(maxDocumentEditCharacters),
    new_text: z.string().max(maxDocumentEditCharacters),
    replace_all: z.boolean().default(false),
  })
  .strict();
export const documentEditsSchema = z
  .array(documentEditSchema)
  .min(1)
  .max(100)
  .superRefine((edits, ctx) => {
    if (
      edits.reduce(
        (size, edit) => size + edit.old_text.length + edit.new_text.length,
        0,
      ) > maxDocumentEditCharacters
    )
      ctx.addIssue({
        code: "custom",
        message: "局部修订片段总长度超过文档限制。",
      });
  });
export type DocumentEdit = z.input<typeof documentEditSchema>;

export const documentRevisionShape = {
  title: z.string().trim().min(1).max(180).optional(),
  markdown: z.string().max(maxDocumentEditCharacters).optional(),
  edits: documentEditsSchema.optional(),
};
export type DocumentRevisionBody = {
  title?: string;
  markdown?: string;
  edits?: DocumentEdit[];
};
export function refineDocumentRevision(
  body: DocumentRevisionBody,
  ctx: z.RefinementCtx,
) {
  if ((body.markdown === undefined) === (body.edits === undefined))
    ctx.addIssue({
      code: "custom",
      message: "正文 markdown 和局部 edits 必须提供其中之一，不能同时提供。",
    });
  if (body.markdown !== undefined && body.title === undefined)
    ctx.addIssue({
      code: "custom",
      path: ["title"],
      message: "全文修订需要标题；局部修订可省略标题以保留原题。",
    });
}
export const documentRevisionBodySchema = z
  .object(documentRevisionShape)
  .strict()
  .superRefine(refineDocumentRevision);

/** Plan every range against the same original. Never let an earlier replacement
 * become a later match. The caller commits only the completely validated body. */
export function applyDocumentEdits(
  original: string,
  raw: DocumentEdit[],
): string {
  const edits = documentEditsSchema.parse(raw);
  const ranges: { start: number; end: number; text: string }[] = [];
  let length = original.length;
  for (const [index, edit] of edits.entries()) {
    let count = 0;
    let offset = 0;
    for (;;) {
      const start = original.indexOf(edit.old_text, offset);
      if (start < 0) break;
      count++;
      if (count > 1 && !edit.replace_all)
        throw new DomainError(
          "invalid",
          `第 ${index + 1} 项原文匹配多处；请提供唯一片段，或明确 replace_all。`,
        );
      const end = start + edit.old_text.length;
      ranges.push({ start, end, text: edit.new_text });
      // A valid non-overlapping plan cannot contain more ranges than code
      // units in the original. Bound duplicate replace-all requests as well.
      if (ranges.length > original.length)
        throw new DomainError("invalid", "局部修订范围重叠；整批未保存。");
      length += edit.new_text.length - edit.old_text.length;
      offset = end;
    }
    if (!count)
      throw new DomainError(
        "invalid",
        `第 ${index + 1} 项原文未找到；请读取当前版本，不能猜测或模糊替换。`,
      );
  }
  ranges.sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++)
    if (ranges[i]!.start < ranges[i - 1]!.end)
      throw new DomainError(
        "invalid",
        "局部修订范围重叠；整批未保存。请重新读取并提交不重叠的片段。",
      );
  if (length > maxDocumentCharacters)
    throw new DomainError(
      "invalid",
      "修订后的正文超过文档长度限制；整批未保存。",
    );
  const pieces: string[] = [];
  let offset = 0;
  for (const range of ranges) {
    pieces.push(original.slice(offset, range.start), range.text);
    offset = range.end;
  }
  pieces.push(original.slice(offset));
  const result = pieces.join("");
  if (result === original)
    throw new DomainError("invalid", "局部修订未改变正文，不创建空版本。");
  return result;
}
