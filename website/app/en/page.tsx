import type { Metadata } from "next";
import { LandingPage } from "../components/LandingPage";

export const metadata: Metadata = {
  title: "From chat completion to structured Context evaluation",
  description:
    "Morphz is an S-Expression Cognitive Machine: the model handles nondeterministic semantics while the runtime owns facts, authority, state, and execution.",
};

export default function EnglishHome() {
  return <LandingPage locale="en" />;
}
