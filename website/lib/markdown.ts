import { marked } from "marked";

export interface Heading {
  id: string;
  text: string;
  level: number;
}

function plainText(value: string): string {
  return value.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function headingId(value: string): string {
  return plainText(value)
    .toLocaleLowerCase()
    .trim()
    .replace(/[\s/]+/g, "-")
    .replace(/[^\p{L}\p{N}_-]+/gu, "")
    .replace(/^-+|-+$/g, "");
}

export function renderMarkdown(markdown: string): { html: string; headings: Heading[] } {
  const headings: Heading[] = [];
  const seen = new Map<string, number>();
  const rendered = marked.parse(markdown, { gfm: true }) as string;
  const html = rendered.replace(/<h([2-3])>([\s\S]*?)<\/h\1>/g, (_, rawLevel: string, contents: string) => {
    const level = Number(rawLevel);
    const base = headingId(contents) || `section-${headings.length + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const id = count === 0 ? base : `${base}-${count + 1}`;
    headings.push({ id, text: plainText(contents), level });
    return `<h${level} id="${id}">${contents}</h${level}>`;
  });
  return { html, headings };
}
