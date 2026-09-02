import type { Locale } from "./docs";

export const SITE_LINKS = {
  source: "https://github.com/yaowenai/morphz",
  releases: "https://github.com/yaowenai/morphz/releases",
  issues: "https://github.com/yaowenai/morphz/issues",
  research:
    "https://github.com/yaowenai/morphz/tree/main/docs/research/paper_evaluation",
  liveAgent: "https://chat.morphz.ai",
  company: "https://newvar.ai",
} as const;

export function sitePath(locale: Locale, path: string): string {
  if (locale === "zh") return path;
  return path === "/" ? "/en" : `/en${path}`;
}

export function paperPdf(locale: Locale): string {
  const suffix = locale === "zh" ? "zh" : "en";
  return `/paper/morphz_nondeterministic_cognitive_symbol_evaluation_preprint_${suffix}.pdf`;
}
