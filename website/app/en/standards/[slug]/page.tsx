import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { StandardsArticle } from "../../../components/StandardsArticle";
import { standardFor, standardsFor } from "@/lib/standards";

export function generateStaticParams() {
  return standardsFor("en").map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const standard = standardFor("en", slug);
  return standard ? {
    title: standard.title,
    description: `${standard.title}: a Morphz Open Standards draft.`,
    alternates: {
      canonical: `/en/standards/${slug}`,
      languages: { "zh-CN": `/standards/${slug}`, en: `/en/standards/${slug}` },
    },
  } : {};
}

export default async function EnglishStandardPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const standard = standardFor("en", slug);
  if (!standard) notFound();
  return <StandardsArticle locale="en" standard={standard} />;
}
