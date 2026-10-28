import { notFound, redirect } from "next/navigation";
import { onlineExperiencePublished } from "@/lib/public-experience";

export default function ChineseExperiencePage() {
  if (!onlineExperiencePublished()) notFound();
  redirect("/product");
}
