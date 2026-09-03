import type { Metadata } from "next";
import { DocsIndex } from "../components/DocsShell";

export const metadata: Metadata = {
  title: "文档",
  description: "Morphz 中文文档：入门、概念、指南、运维与参考。",
  alternates: { canonical: "/docs", languages: { "zh-CN": "/docs", en: "/en/docs" } },
};
export default function DocsPage() { return <DocsIndex locale="zh" />; }
