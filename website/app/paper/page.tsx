import type { Metadata } from "next";
import { PaperPage } from "../components/ProjectPages";

export const metadata: Metadata = {
  title: "论文：结构化上下文上的非确定性认知符号求值",
  description: "Morphz 计算模型、实现边界与分层实验的双语预印本。",
};

export default function ChinesePaperPage() {
  return <PaperPage locale="zh" />;
}
