import type { Locale } from "./docs";

export const SITE_LINKS = {
  source: "https://github.com/morphz-ai/morphz",
  releases: "https://github.com/morphz-ai/morphz/releases",
  issues: "https://github.com/morphz-ai/morphz/issues",
  standards: "https://github.com/morphz-ai/morphz/tree/main/docs/standards",
  research:
    "https://github.com/morphz-ai/morphz/tree/main/docs/research/paper_evaluation",
} as const;

export function sitePath(locale: Locale, path: string): string {
  if (locale === "zh") return path;
  return path === "/" ? "/en" : `/en${path}`;
}

export function paperPdf(locale: Locale): string {
  const suffix = locale === "zh" ? "zh" : "en";
  return `/paper/morphz_nondeterministic_cognitive_symbol_evaluation_preprint_${suffix}.pdf`;
}
