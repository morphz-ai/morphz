import { maxTtsSegmentCharacters } from "./audio.js";

export type ReadingChunk = { start: number; end: number };
export type ReadingChapter = { title: string; chunk: number };
const chapterPattern = () =>
  /^(?:#{1,6}\s+[^\n]{1,100}|第[零〇一二三四五六七八九十百千万两\d]+[章节卷部回][^\n]{0,90}|(?:chapter|part)\s+[\wIVX]+[^\n]{0,90})$/gim;

/** Exact coverage, including whitespace. Keep only offsets, not N copies of a book. */
export function readingChunks(text: string, size = 320): ReadingChunk[] {
  if (!Number.isInteger(size) || size < 2 || size > maxTtsSegmentCharacters)
    throw new Error("Invalid speech segment size");
  const result: ReadingChunk[] = [];
  const headings = Array.from(
    text.matchAll(chapterPattern()),
    (match) => match.index,
  );
  let heading = 0;
  let start = 0;
  while (start < text.length) {
    while (heading < headings.length && headings[heading]! <= start) heading++;
    const boundary = headings[heading] ?? text.length;
    let end = Math.min(start + size, text.length, boundary);
    if (end < text.length && end !== boundary) {
      const floor = start + Math.floor(size / 2);
      for (let i = end - 1; i >= floor; i--) {
        if (/[\n。！？.!?；;]/u.test(text[i]!)) {
          end = i + 1;
          break;
        }
      }
      // Never cut a UTF-16 surrogate pair.
      const code = text.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end--;
    }
    result.push({ start, end });
    start = end;
  }
  return result;
}

export function readingChapters(
  text: string,
  chunks: ReadingChunk[],
): ReadingChapter[] {
  const chapters: ReadingChapter[] = [];
  const heading = chapterPattern();
  let chunk = 0;
  for (const match of text.matchAll(heading)) {
    while (chunk + 1 < chunks.length && chunks[chunk + 1]!.start <= match.index)
      chunk++;
    chapters.push({ title: match[0].replace(/^#+\s+/, "").trim(), chunk });
  }
  return chapters;
}

export type ReadingProgress = {
  index: number;
  seconds: number;
  rate: number;
  complete: boolean;
};
export function readingProgress(
  value: unknown,
  count: number,
): ReadingProgress {
  const p = value as Partial<ReadingProgress> | null;
  return {
    index:
      p && Number.isInteger(p.index) && p.index! >= 0 && p.index! < count
        ? p.index!
        : 0,
    seconds:
      p &&
      typeof p.seconds === "number" &&
      Number.isFinite(p.seconds) &&
      p.seconds >= 0
        ? p.seconds
        : 0,
    rate:
      p && typeof p.rate === "number" && p.rate >= 0.5 && p.rate <= 2
        ? p.rate
        : 1,
    complete: p?.complete === true,
  };
}
