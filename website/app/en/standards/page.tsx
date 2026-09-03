import type { Metadata } from "next";
import { StandardsPage } from "../../components/StandardsPage";

export const metadata: Metadata = {
  title: "Morphz Open Technical Standards",
  description: "Open technical Drafts for durable cognition, causal agent experience, Cognitive Applications, Yao, and cognitive exchange.",
  alternates: { canonical: "/en/standards", languages: { "zh-CN": "/standards", en: "/en/standards" } },
};

export default function EnglishStandardsPage() {
  return <StandardsPage locale="en" />;
}
