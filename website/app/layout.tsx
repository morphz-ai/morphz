import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "./clean-theme.css";
import "./motion.css";
import { SiteMotion } from "./components/SiteMotion";

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
  title: { default: "Morphz — One Agent. Many Objectives. Advancing in Parallel.", template: "%s · Morphz" },
  description: "Morphz is an open-source agent for long-running, concurrent work, built on persistent cognitive state, multiplexed Session I/O, durable scheduling, and governed execution.",
  openGraph: {
    type: "website",
    siteName: "Morphz",
    title: "Morphz — One Agent. Many Objectives. Advancing in Parallel.",
    description: "An open-source agent for long-running, concurrent work, built on persistent cognitive state, multiplexed Session I/O, durable scheduling, and governed execution.",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Morphz — One Agent. Many Objectives. Advancing in Parallel." }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Morphz — One Agent. Many Objectives. Advancing in Parallel.",
    description: "An open-source agent for long-running, concurrent work, built on persistent cognitive state, multiplexed Session I/O, durable scheduling, and governed execution.",
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
        <SiteMotion />
        {children}
      </body>
    </html>
  );
}
