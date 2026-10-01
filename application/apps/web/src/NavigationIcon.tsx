import type { ReactNode } from "react";

export type NavigationKind =
  "dialogue" | "inbox" | "content" | "desk" | "projects";

// Product navigation only. General controls keep the existing Lucide family.
// The containing button supplies the accessible name and selected state.
const glyphs: Record<NavigationKind, ReactNode> = {
  dialogue: (
    <path d="M21 11.4c0 4.7-4 8.6-9 8.6a9.5 9.5 0 0 1-4.2-1L3 21l1.2-4.5A8.1 8.1 0 0 1 3 11.4C3 6.8 7 3 12 3s9 3.8 9 8.4Z" />
  ),
  inbox: (
    <>
      <path d="m3 6 2.5 2.5L9 4.5M13 6.5h8M12 17h9" />
      <circle cx="5.5" cy="17" r="2.5" />
    </>
  ),
  content: (
    <>
      <path d="M17 5V4.5A1.5 1.5 0 0 0 15.5 3h-11A1.5 1.5 0 0 0 3 4.5v11A1.5 1.5 0 0 0 4.5 17H5" />
      <rect x="7" y="7" width="14" height="14" rx="2.5" />
      <path d="M11 12h6" />
    </>
  ),
  desk: (
    <>
      <rect x="3" y="3" width="7" height="18" rx="2" />
      <rect x="14" y="3" width="7" height="7" rx="2" />
      <rect x="14" y="14" width="7" height="7" rx="2" />
    </>
  ),
  projects: (
    <path d="M3 7a2 2 0 0 1 2-2h4.2a2 2 0 0 1 1.4.6L13 8h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
  ),
};

export function NavigationIcon({ kind }: { kind: NavigationKind }) {
  return (
    <svg
      className="navigation-icon"
      data-navigation-icon={kind}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {glyphs[kind]}
    </svg>
  );
}
