import type { Metadata } from "next";
import { LandingPage } from "./components/LandingPage";

export const metadata: Metadata = {
  title: "从聊天补全到结构化上下文求值",
  description: "Morphz 是一台 S 表达式认知机：模型负责非确定性语义处理，运行时负责事实、权限、状态与执行。",
  alternates: { canonical: "/", languages: { "zh-CN": "/", en: "/en" } },
};

export default function Home() {
  return <LandingPage locale="zh" />;
}
