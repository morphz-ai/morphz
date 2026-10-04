import {
  FileText,
  BookOpen,
  Image,
  CircleCheck,
  Globe,
  Table2,
} from "lucide-react";
import type { Content } from "../../../../packages/core/src/model.js";

export const kindLabel = {
  document: "文档",
  image: "图片",
  task: "事项",
  pdf: "PDF",
  publication: "读物",
  website: "网页链接",
  interactive: "表格",
};
export function ObjectIcon({ kind }: { kind: Content["kind"] }) {
  const Icon = {
    document: FileText,
    image: Image,
    task: CircleCheck,
    pdf: FileText,
    publication: BookOpen,
    website: Globe,
    interactive: Table2,
  }[kind];
  return <Icon size={16} />;
}
