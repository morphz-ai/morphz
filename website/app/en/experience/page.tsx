import { notFound, redirect } from "next/navigation";
import { onlineExperiencePublished } from "@/lib/public-experience";

export default function EnglishExperiencePage() {
  if (!onlineExperiencePublished()) notFound();
  redirect("/en/product");
}
