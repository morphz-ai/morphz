import type { Metadata } from "next";
import { StandardsPage } from "../components/StandardsPage";

export const metadata: Metadata = {
  title: "Morphz 开放规范",
  description: "面向持久认知、因果经验、认知应用、Yao 与认知交换的开放技术规范草案。",
  alternates: { canonical: "/standards", languages: { "zh-CN": "/standards", en: "/en/standards" } },
};

export default function ChineseStandardsPage() {
  return <StandardsPage locale="zh" />;
}
