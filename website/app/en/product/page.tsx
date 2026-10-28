import type { Metadata } from "next";
import { onlineExperiencePublished } from "@/lib/public-experience";
import { ExperiencePage } from "../../components/ExperiencePage";

export function generateMetadata(): Metadata {
  if (!onlineExperiencePublished()) return { title: "Morphz", robots: { index: false, follow: false } };
  return {
  title: "Morphz Product",
  description: "Meet the official Morphz, your own Agent, and the open-source Runtime, with their distinct identity and data boundaries.",
  alternates: { canonical: "/en/product", languages: { "zh-CN": "/product", en: "/en/product" } },
  };
}

export default function EnglishProductPage() {
  return <ExperiencePage locale="en" />;
}
