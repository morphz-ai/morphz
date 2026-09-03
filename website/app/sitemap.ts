import type { MetadataRoute } from "next";
import { blogsFor } from "@/lib/blog";
import { docsFor } from "@/lib/docs";

const origin = process.env.NEXT_PUBLIC_SITE_URL ?? "https://morphz.ai";

function absolute(path: string): string {
  return new URL(path, origin).toString();
}

export default function sitemap(): MetadataRoute.Sitemap {
  const bilingualPages = ["", "/blog", "/paper", "/docs", "/download"];
  const staticPages: MetadataRoute.Sitemap = bilingualPages.flatMap((path) => [
    {
      url: absolute(path || "/"),
      changeFrequency: path === "" ? "weekly" : "monthly",
      priority: path === "" ? 1 : 0.8,
      alternates: {
        languages: {
          "zh-CN": absolute(path || "/"),
          en: absolute(`/en${path}`),
        },
      },
    },
    {
      url: absolute(`/en${path}`),
      changeFrequency: path === "" ? "weekly" : "monthly",
      priority: path === "" ? 1 : 0.8,
      alternates: {
        languages: {
          "zh-CN": absolute(path || "/"),
          en: absolute(`/en${path}`),
        },
      },
    },
  ]);

  const docPages: MetadataRoute.Sitemap = docsFor("zh").flatMap(({ slug }) => [
    {
      url: absolute(`/docs/${slug}`),
      changeFrequency: "monthly",
      priority: 0.7,
      alternates: {
        languages: {
          "zh-CN": absolute(`/docs/${slug}`),
          en: absolute(`/en/docs/${slug}`),
        },
      },
    },
    {
      url: absolute(`/en/docs/${slug}`),
      changeFrequency: "monthly",
      priority: 0.7,
      alternates: {
        languages: {
          "zh-CN": absolute(`/docs/${slug}`),
          en: absolute(`/en/docs/${slug}`),
        },
      },
    },
  ]);

  const blogPages: MetadataRoute.Sitemap = blogsFor("zh").flatMap(({ slug, published }) => [
    {
      url: absolute(`/blog/${slug}`),
      lastModified: published,
      changeFrequency: "yearly",
      priority: 0.7,
      alternates: {
        languages: {
          "zh-CN": absolute(`/blog/${slug}`),
          en: absolute(`/en/blog/${slug}`),
        },
      },
    },
    {
      url: absolute(`/en/blog/${slug}`),
      lastModified: published,
      changeFrequency: "yearly",
      priority: 0.7,
      alternates: {
        languages: {
          "zh-CN": absolute(`/blog/${slug}`),
          en: absolute(`/en/blog/${slug}`),
        },
      },
    },
  ]);

  return [...staticPages, ...docPages, ...blogPages];
}
