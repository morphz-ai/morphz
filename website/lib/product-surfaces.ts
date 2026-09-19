/** Public destinations are configured only after the corresponding experience is live. */
function publicDestination(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
      return url.toString();
    }
  } catch {
    // A missing or invalid destination must never create a dead product CTA.
  }
  return null;
}

export function productSurfaces() {
  return {
    officialPersona: publicDestination(process.env.NEXT_PUBLIC_MORPHZ_OFFICIAL_PERSONA_URL),
    userWeb: publicDestination(process.env.NEXT_PUBLIC_MORPHZ_USER_WEB_URL),
  };
}
