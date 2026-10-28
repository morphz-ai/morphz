/** Product destinations are configured only after the corresponding surface is available. */
function productDestination(value: string | undefined, localPreview = false): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const developmentHost = ["localhost", "127.0.0.1"].includes(url.hostname) || url.hostname.endsWith(".local");
    if (url.protocol === "https:" || (localPreview && process.env.NODE_ENV === "development" && url.protocol === "http:" && developmentHost)) {
      return url.toString();
    }
  } catch {
    // A missing or invalid destination must never create a dead product CTA.
  }
  return null;
}

export function productSurfaces() {
  return {
    officialPersona: productDestination(process.env.NEXT_PUBLIC_MORPHZ_OFFICIAL_PERSONA_URL, true),
    userWeb: productDestination(process.env.NEXT_PUBLIC_MORPHZ_USER_WEB_URL),
    userPreview: productDestination(process.env.NEXT_PUBLIC_MORPHZ_USER_AGENT_PREVIEW_URL),
  };
}
