import type { Metadata } from "next";
import { LandingPage } from "./components/LandingPage";

export const metadata: Metadata = {
  title: "让 Agent 拥有可持续的认知",
  description: "Morphz 是面向持久认知、可恢复执行与模型无关接入的 Agent Runtime。",
};

export default function Home() {
  return <LandingPage locale="zh" />;
}
