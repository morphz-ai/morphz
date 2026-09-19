import type { Metadata } from "next";
import { ExperiencePage } from "../components/ExperiencePage";

export const metadata: Metadata = {
  title: "体验 Morphz",
  description: "认识官方 Morphz，了解如何拥有自己的 Agent，以及两种体验的身份与数据边界。",
  alternates: { canonical: "/experience", languages: { "zh-CN": "/experience", en: "/en/experience" } },
};

export default function ChineseExperiencePage() {
  return <ExperiencePage locale="zh" />;
}
