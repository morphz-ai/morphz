import type { Metadata } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = new URL(`${protocol}://${host}`);
  const image = new URL("/og.png", origin).toString();
  return {
    metadataBase: origin,
    title: { default: "Morphz — S-Expression Cognitive Machine", template: "%s · Morphz" },
    description: "Morphz is an S-Expression Cognitive Machine that evaluates structured Context through a nondeterministic semantic processor and a deterministic runtime kernel.",
    openGraph: {
      type: "website",
      siteName: "Morphz",
      title: "Morphz — S-Expression Cognitive Machine",
      description: "From chat completion to structured Context evaluation.",
      images: [{ url: image, width: 1200, height: 630, alt: "Morphz Agent Runtime" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Morphz — S-Expression Cognitive Machine",
      description: "From chat completion to structured Context evaluation.",
      images: [image],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
