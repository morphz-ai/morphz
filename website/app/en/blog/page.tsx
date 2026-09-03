import type { Metadata } from "next";
import { BlogIndex } from "../../components/BlogShell";

export const metadata: Metadata = {
  title: "Technical Notes",
  description: "Technical articles from the Morphz project on agent cognition, runtimes, and computational models.",
  alternates: { canonical: "/en/blog", languages: { "zh-CN": "/blog", en: "/en/blog" } },
};

export default function EnglishBlogPage() {
  return <BlogIndex locale="en" />;
}
