import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { StandardsArticle } from "../../components/StandardsArticle";
import { standardFor, standardsFor } from "@/lib/standards";

export function generateStaticParams() {
  return standardsFor("zh").map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const standard = standardFor("zh", slug);
  return standard ? {
    title: standard.title,
    description: `${standard.title}：Morphz 开放规范草案。`,
    alternates: {
      canonical: `/standards/${slug}`,
      languages: { "zh-CN": `/standards/${slug}`, en: `/en/standards/${slug}` },
    },
  } : {};
}

export default async function ChineseStandardPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const standard = standardFor("zh", slug);
  if (!standard) notFound();
  return <StandardsArticle locale="zh" standard={standard} />;
}
