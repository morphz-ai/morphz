import type { Metadata } from "next";
import { LandingPage } from "./components/LandingPage";

export const metadata: Metadata = {
  title: "一个智能体，多个目标，并发推进",
  description: "Morphz 是一款面向长期并发工作的开源智能体，具备持久认知状态、多路会话输入输出、持久调度与受控执行。",
  alternates: { canonical: "/", languages: { "zh-CN": "/", en: "/en" } },
};

export default function Home() {
  return <LandingPage locale="zh" />;
}
