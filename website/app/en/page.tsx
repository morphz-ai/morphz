import type { Metadata } from "next";
import { LandingPage } from "../components/LandingPage";

export const metadata: Metadata = {
  title: "Durable cognition for agents",
  description:
    "Morphz is an agent runtime for durable cognition, recoverable execution, and provider-independent model access.",
};

export default function EnglishHome() {
  return <LandingPage locale="en" />;
}
