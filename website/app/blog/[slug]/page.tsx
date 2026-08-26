import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BlogArticle } from "../../components/BlogShell";
import { blogFor, blogsFor } from "@/lib/blog";

export function generateStaticParams() {
  return blogsFor("zh").map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const post = blogFor("zh", slug);
  if (!post) return {};
  return {
    title: post.title,
    description: post.description,
    authors: [{ name: post.author }],
    alternates: { languages: { "zh-CN": `/blog/${slug}`, en: `/en/blog/${slug}` } },
    openGraph: {
      type: "article",
      title: post.title,
      description: post.description,
      publishedTime: post.published,
      authors: [post.author],
      images: [],
    },
    twitter: { card: "summary", title: post.title, description: post.description, images: [] },
  };
}

export default async function ChineseBlogPost({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = blogFor("zh", slug);
  if (!post) notFound();
  return <BlogArticle locale="zh" post={post} />;
}
