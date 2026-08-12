import type { Metadata } from "next";
import { DocsIndex } from "../../components/DocsShell";

export const metadata: Metadata = { title: "Documentation", description: "Morphz documentation: getting started, concepts, guides, operations, and reference." };
export default function EnglishDocsPage() { return <DocsIndex locale="en" />; }
