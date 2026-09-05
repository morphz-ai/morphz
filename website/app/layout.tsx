import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "./clean-theme.css";
import "./motion.css";
import "./brand-motion.css";
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
const themeInitScript = `try{const t=localStorage.getItem("morphz-theme");if(t==="light"||t==="dark"){document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=t}}catch{}`;

export const metadata: Metadata = {
  metadataBase: canonicalOrigin,
  title: { default: "Morphz — One Agent. Many Objectives. Advancing in Parallel.", template: "%s · Morphz" },
  description: "Morphz is an open-source agent for long-running, concurrent work, built on persistent cognitive state, multiplexed Session I/O, durable scheduling, and governed execution.",
  icons: {
    icon: [
      { url: "/brand/morphz-favicon-cyan-32.png", type: "image/png", sizes: "32x32" },
      { url: "/brand/morphz-favicon-cyan.svg", type: "image/svg+xml", sizes: "any" },
    ],
  },
  openGraph: {
    type: "website",
    siteName: "Morphz",
    title: "Morphz — One Agent. Many Objectives. Advancing in Parallel.",
    description: "An open-source agent for long-running, concurrent work, built on persistent cognitive state, multiplexed Session I/O, durable scheduling, and governed execution.",
    images: [{
      url: "/brand/og-cyan-v2.png",
      width: 1731,
      height: 909,
      alt: "Morphz — Autonomous context maintenance. Concurrent scheduling. Governed execution.",
    }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Morphz — One Agent. Many Objectives. Advancing in Parallel.",
    description: "An open-source agent for long-running, concurrent work, built on persistent cognitive state, multiplexed Session I/O, durable scheduling, and governed execution.",
    images: ["/brand/og-cyan-v2.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <SiteMotion />
        {children}
      </body>
    </html>
  );
}
