import type { Metadata } from "next";
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

const canonicalOrigin = new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://morphz.ai");

export const metadata: Metadata = {
  metadataBase: canonicalOrigin,
  title: { default: "Morphz — S-Expression Cognitive Machine", template: "%s · Morphz" },
  description: "Morphz is an S-Expression Cognitive Machine that evaluates structured Context through a nondeterministic semantic processor and a deterministic runtime kernel.",
  openGraph: {
    type: "website",
    siteName: "Morphz",
    title: "Morphz — S-Expression Cognitive Machine",
    description: "From chat completion to structured Context evaluation.",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Morphz S-Expression Cognitive Machine" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Morphz — S-Expression Cognitive Machine",
    description: "From chat completion to structured Context evaluation.",
    images: ["/og.png"],
  },
};

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
