import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DocArticle } from "../../components/DocsShell";
import { docFor, docsFor } from "@/lib/docs";

export function generateStaticParams() { return docsFor("zh").map(({ slug }) => ({ slug })); }
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> { const { slug } = await params; const doc = docFor("zh", slug); return doc ? { title: doc.title, description: doc.description, alternates: { canonical: `/docs/${slug}`, languages: { "zh-CN": `/docs/${slug}`, en: `/en/docs/${slug}` } } } : {}; }
export default async function ChineseDocPage({ params }: { params: Promise<{ slug: string }> }) { const { slug } = await params; const doc = docFor("zh", slug); if (!doc) notFound(); return <DocArticle locale="zh" doc={doc} />; }
