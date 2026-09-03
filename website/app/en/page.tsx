import type { Metadata } from "next";
import { LandingPage } from "../components/LandingPage";

export const metadata: Metadata = {
  title: "One Agent. Many Objectives. Advancing in Parallel.",
  description:
    "Morphz is an open-source agent for long-running, concurrent work, built on persistent cognitive state, multiplexed Session I/O, durable scheduling, and governed execution.",
  alternates: { canonical: "/en", languages: { "zh-CN": "/", en: "/en" } },
};

export default function EnglishHome() {
  return <LandingPage locale="en" />;
}
