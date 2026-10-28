import type { Metadata } from "next";
import "./prototype.css";
import "./project-home.css";

export const metadata: Metadata = {
  title: "Morphz 首页方案对比",
  description: "技术官网与 Agent 使用入口的三个交互原型。",
  robots: { index: false, follow: false },
};

export default function HomepageLabLayout({ children }: { children: React.ReactNode }) {
  return children;
}
