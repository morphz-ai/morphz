import type { Metadata } from "next";
import { DownloadPage } from "../../components/ProjectPages";

export const metadata: Metadata = {
  title: "Download and run Morphz",
  description: "Run the Morphz Runtime, TUI, and Dashboard natively on macOS, Linux, or Windows.",
  alternates: { canonical: "/en/download", languages: { "zh-CN": "/download", en: "/en/download" } },
};

export default function EnglishDownloadPage() {
  return <DownloadPage locale="en" />;
}
