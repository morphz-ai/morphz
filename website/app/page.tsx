import type { Metadata } from "next";
import { LandingPage } from "./components/LandingPage";

export const metadata: Metadata = {
  title: "让代理拥有可持续的认知",
  description: "Morphz 是面向持久认知、可恢复执行与模型无关接入的代理运行时。",
};

export default function Home() {
  return <LandingPage locale="zh" />;
}
