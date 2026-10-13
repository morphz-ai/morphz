/** Online-service content needs explicit release approval, not just a destination URL. */
export function onlineExperiencePublished(
  releaseState = process.env.NEXT_PUBLIC_MORPHZ_ONLINE_EXPERIENCE_PUBLISHED,
): boolean {
  return releaseState === "true";
}
