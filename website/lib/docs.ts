import { generatedDocs } from "./docs.generated";

export type Locale = "zh" | "en";
export type DocSection = "start" | "concepts" | "guides" | "operations" | "reference";

export interface DocRecord {
  locale: Locale;
  slug: string;
  title: string;
  description: string;
  section: DocSection;
  order: number;
  status: "current" | "preview";
  body: string;
}

export const sectionLabels: Record<Locale, Record<DocSection, string>> = {
  zh: { start: "开始使用", concepts: "核心概念", guides: "使用指南", operations: "运维与排障", reference: "参考" },
  en: { start: "Get started", concepts: "Core concepts", guides: "Guides", operations: "Operations", reference: "Reference" },
};

export function docsFor(locale: Locale): DocRecord[] {
  return (generatedDocs as DocRecord[])
    .filter((doc) => doc.locale === locale)
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

export function docFor(locale: Locale, slug: string): DocRecord | undefined {
  return docsFor(locale).find((doc) => doc.slug === slug);
}

export function docHref(locale: Locale, slug?: string): string {
  const root = locale === "zh" ? "/docs" : "/en/docs";
  return slug ? `${root}/${slug}` : root;
}

export function otherLocaleHref(locale: Locale, slug?: string): string {
  return docHref(locale === "zh" ? "en" : "zh", slug);
}
