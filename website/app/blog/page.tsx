import type { Metadata } from "next";
import { BlogIndex } from "../components/BlogShell";

export const metadata: Metadata = {
  title: "技术文章",
  description: "Morphz 关于代理认知、运行时与计算模型的技术文章。",
};

export default function ChineseBlogPage() {
  return <BlogIndex locale="zh" />;
}
