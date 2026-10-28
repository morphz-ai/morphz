import { notFound } from "next/navigation";
import { HomepagePrototype } from "../prototype";

export function generateStaticParams() {
  return [{ variant: "a" }, { variant: "b" }, { variant: "c" }];
}

export default async function VariantPage({ params }: { params: Promise<{ variant: string }> }) {
  const { variant } = await params;
  if (variant !== "a" && variant !== "b" && variant !== "c") notFound();
  return <HomepagePrototype key={variant} variant={variant} />;
}
