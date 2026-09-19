import type { Metadata } from "next";
import { ExperiencePage } from "../../components/ExperiencePage";

export const metadata: Metadata = {
  title: "Experience Morphz",
  description: "Meet the official Morphz, explore your own Agent, and understand the separate identity and data boundaries.",
  alternates: { canonical: "/en/experience", languages: { "zh-CN": "/experience", en: "/en/experience" } },
};

export default function EnglishExperiencePage() {
  return <ExperiencePage locale="en" />;
}
