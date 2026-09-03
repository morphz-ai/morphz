import type { Metadata } from "next";
import { DownloadPage } from "../components/ProjectPages";

export const metadata: Metadata = {
  title: "下载与运行 Morphz",
  description: "在 macOS、Linux 或 Windows 上原生运行 Morphz、终端界面与控制台。",
  alternates: { canonical: "/download", languages: { "zh-CN": "/download", en: "/en/download" } },
};

export default function ChineseDownloadPage() {
  return <DownloadPage locale="zh" />;
}
