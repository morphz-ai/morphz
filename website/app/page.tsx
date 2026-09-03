import type { Metadata } from "next";
import { LandingPage } from "./components/LandingPage";

export const metadata: Metadata = {
  title: "一个智能体，多个目标，并发推进",
  description: "Morphz 是一款面向长期并发工作的开源智能体，让长期记忆成为持续演化的认知，并以结构化上下文、持久调度与受控执行推进多个目标。",
  alternates: { canonical: "/", languages: { "zh-CN": "/", en: "/en" } },
};

export default function Home() {
  return <LandingPage locale="zh" />;
}
