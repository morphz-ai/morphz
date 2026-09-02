import type { Metadata } from "next";
import { PaperPage } from "../../components/ProjectPages";

export const metadata: Metadata = {
  title: "Paper: Nondeterministic Cognitive Symbol Evaluation",
  description: "The bilingual preprint defining the Morphz computational model, implementation boundary, and layered evidence.",
};

export default function EnglishPaperPage() {
  return <PaperPage locale="en" />;
}
