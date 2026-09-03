import { generatedStandards } from "./standards.generated";
import type { Locale } from "./docs";

export type StandardFamily = "context" | "trajectory" | "applications" | "exchange";

export interface StandardRecord {
  locale: Locale;
  slug: string;
  title: string;
  sourcePath: string;
  body: string;
  family: StandardFamily;
  order: number;
}

const catalog: Record<string, { family: StandardFamily; order: number }> = {
  structured_context_constitution_v1: { family: "context", order: 10 },
  morphz_structured_context_specification_v1: { family: "context", order: 20 },
  morphz_conformance_suite_v1: { family: "context", order: 30 },
  morphz_agent_trajectory_specification_v0_1: { family: "trajectory", order: 40 },
  morphz_agent_trajectory_reference_implementation_verification_v0_1: { family: "trajectory", order: 50 },
  morphz_harness_specification_v0_1: { family: "applications", order: 60 },
  hns_package_format_specification_v0_1: { family: "applications", order: 70 },
  yao_core_language_specification_v0_1: { family: "applications", order: 80 },
  yao_evaluation_semantics_v0_1: { family: "applications", order: 90 },
  yao_morphz_runtime_profile_v0_1: { family: "applications", order: 100 },
  yao_reference_implementation_verification_v0_1: { family: "applications", order: 110 },
  morphz_mind_frame_exchange_protocol_v0_1: { family: "exchange", order: 120 },
};

export const standardFamilyLabels: Record<Locale, Record<StandardFamily, string>> = {
  zh: {
    context: "结构化上下文",
    trajectory: "智能体轨迹",
    applications: "认知应用",
    exchange: "认知交换",
  },
  en: {
    context: "Structured Context",
    trajectory: "Agent Trajectory",
    applications: "Cognitive Applications",
    exchange: "Mind Frame Exchange",
  },
};

const records = (generatedStandards as Omit<StandardRecord, "family" | "order">[])
  .filter((standard) => standard.slug in catalog)
  .map((standard) => ({ ...standard, ...catalog[standard.slug] }));

export function standardsFor(locale: Locale): StandardRecord[] {
  return records.filter((standard) => standard.locale === locale).sort((a, b) => a.order - b.order);
}

export function standardFor(locale: Locale, slug: string): StandardRecord | undefined {
  return standardsFor(locale).find((standard) => standard.slug === slug);
}

export function standardHref(locale: Locale, slug: string): string {
  return `${locale === "zh" ? "" : "/en"}/standards/${slug}`;
}

export function standardsIndexHref(locale: Locale): string {
  return `${locale === "zh" ? "" : "/en"}/standards`;
}

export function standardSourceHref(standard: StandardRecord): string {
  return `https://github.com/morphz-ai/morphz/blob/main/${standard.sourcePath}`;
}

function resolveSourcePath(sourcePath: string, target: string): string {
  const segments = sourcePath.split("/");
  segments.pop();
  for (const segment of target.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}

export function standardBodyForWeb(standard: StandardRecord): string {
  return standard.body.replace(/\]\(([^)\s]+\.md)(#[^)]+)?\)/g, (match, target: string, anchor = "") => {
    const sourcePath = resolveSourcePath(standard.sourcePath, target);
    const internal = records.find((candidate) => candidate.sourcePath === sourcePath);
    if (internal) return `](${standardHref(internal.locale, internal.slug)}${anchor})`;
    return `](https://github.com/morphz-ai/morphz/blob/main/${sourcePath}${anchor})`;
  });
}
