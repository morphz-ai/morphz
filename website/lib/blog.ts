import { generatedBlogs } from "./blog.generated";
import type { Locale } from "./docs";

export interface BlogRecord {
  locale: Locale;
  slug: string;
  title: string;
  description: string;
  published: string;
  author: string;
  category: string;
  body: string;
}

export function blogsFor(locale: Locale): BlogRecord[] {
  return (generatedBlogs as BlogRecord[])
    .filter((post) => post.locale === locale)
    .sort((left, right) => right.published.localeCompare(left.published));
}

export function blogFor(locale: Locale, slug: string): BlogRecord | undefined {
  return blogsFor(locale).find((post) => post.slug === slug);
}

export function blogHref(locale: Locale, slug?: string): string {
  const root = locale === "zh" ? "/blog" : "/en/blog";
  return slug ? `${root}/${slug}` : root;
}

export function otherBlogLocaleHref(locale: Locale, slug?: string): string {
  return blogHref(locale === "zh" ? "en" : "zh", slug);
}
