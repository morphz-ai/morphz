import type { Metadata } from "next";
import { onlineExperiencePublished } from "@/lib/public-experience";
import { ExperiencePage } from "../components/ExperiencePage";

export function generateMetadata(): Metadata {
  if (!onlineExperiencePublished()) return { title: "Morphz", robots: { index: false, follow: false } };
  return {
  title: "Morphz 产品",
  description: "了解 Morphz 官方人格、用户 Agent 与开源 Runtime，以及各自的身份和数据边界。",
  alternates: { canonical: "/product", languages: { "zh-CN": "/product", en: "/en/product" } },
  };
}

export default function ChineseProductPage() {
  return <ExperiencePage locale="zh" />;
}
