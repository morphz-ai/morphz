import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DocArticle } from "../../../components/DocsShell";
import { docFor, docsFor } from "@/lib/docs";

export function generateStaticParams() { return docsFor("en").map(({ slug }) => ({ slug })); }
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> { const { slug } = await params; const doc = docFor("en", slug); return doc ? { title: doc.title, description: doc.description, alternates: { canonical: `/en/docs/${slug}`, languages: { "zh-CN": `/docs/${slug}`, en: `/en/docs/${slug}` } } } : {}; }
export default async function EnglishDocPage({ params }: { params: Promise<{ slug: string }> }) { const { slug } = await params; const doc = docFor("en", slug); if (!doc) notFound(); return <DocArticle locale="en" doc={doc} />; }
