import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { onlineExperiencePublished } from "@/lib/public-experience";
import { ExperiencePage } from "../../components/ExperiencePage";

export function generateMetadata(): Metadata {
  if (!onlineExperiencePublished()) return { title: "Morphz", robots: { index: false, follow: false } };
  return {
  title: "Experience Morphz",
  description: "Meet the official Morphz, explore your own Agent, and understand the separate identity and data boundaries.",
  alternates: { canonical: "/en/experience", languages: { "zh-CN": "/experience", en: "/en/experience" } },
  };
}

export default function EnglishExperiencePage() {
  if (!onlineExperiencePublished()) notFound();
  return <ExperiencePage locale="en" />;
}
