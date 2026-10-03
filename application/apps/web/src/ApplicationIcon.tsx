import { useId, type CSSProperties } from "react";
import { BookOpen, Braces, FileText, Film, Globe, Layers2 } from "lucide-react";
import type { ApplicationCatalogEntry } from "../../../packages/core/src/applications.js";
import {
  applicationIdentities,
  applicationIdentity,
  type ApplicationIdentity,
} from "./application-identity.js";

function ApplicationSymbol({ identity }: { identity: ApplicationIdentity }) {
  const palette = applicationIdentities[identity];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="application-symbol"
      data-application-identity={identity}
      style={{
        "--application-symbol-light": palette.symbol[0],
        "--application-symbol-dark": palette.symbol[1],
      } as CSSProperties}
      aria-hidden="true"
      focusable="false"
    >
      {identity === "browser" ? (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="m16.5 7.5-3 6-6 3 3-6 6-3ZM10.5 10.5l3 3" />
        </>
      ) : identity === "reader" ? (
        <>
          <path d="M12 6.5C9.4 4.5 6.2 4 3 4.8v14c3.2-.8 6.4-.3 9 1.7 2.6-2 5.8-2.5 9-1.7v-14c-3.2-.8-6.4-.3-9 1.7ZM12 6.5v14" />
        </>
      ) : (
        <>
          <path d="m3 7 17-3 1 5-17 3-1-5ZM4 12v7a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2V9M7 6.3l3 4.5M13.5 5.2l3 4.5M8 15h9M8 18h5" />
        </>
      )}
    </svg>
  );
}

function ApplicationEmblem({ identity }: { identity: ApplicationIdentity }) {
  // Launcher and workspace instances coexist; paint-server IDs must not collide.
  const id = useId();
  const field = `${id}-field`,
    face = `${id}-face`;
  const palette = applicationIdentities[identity];
  return (
    <svg
      viewBox="0 0 64 64"
      className="application-emblem"
      data-application-identity={identity}
      aria-hidden="true"
      focusable="false"
      fill="none"
      strokeWidth="0"
    >
      <defs>
        <linearGradient
          id={field}
          x1="5"
          y1="0"
          x2="57"
          y2="64"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor={palette.field[0]} />
          <stop offset="1" stopColor={palette.field[1]} />
        </linearGradient>
        {identity === "browser" && (
          <linearGradient
            id={face}
            x1="18"
            y1="16"
            x2="48"
            y2="49"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#f1fbff" />
            <stop offset="1" stopColor="#a2deff" />
          </linearGradient>
        )}
      </defs>
      <rect width="64" height="64" rx="16" fill={`url(#${field})`} />
      {identity === "browser" ? (
        <>
          <circle cx="32" cy="32" r="19" fill={`url(#${face})`} />
          <path
            d="M32 17v2M47 32h-2M32 47v-2M17 32h2"
            stroke="#79a7cd"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
          <path d="m41 23-6 12-6-6 12-6Z" fill="#286fb5" />
          <path d="m23 41 6-12 6 6-12 6Z" fill="#73acce" />
          <circle cx="32" cy="32" r="2" fill="#eaf8ff" />
        </>
      ) : identity === "reader" ? (
        <>
          <path
            d="M13 19c6-1.9 12.6-.5 19 3.2 6.4-3.7 13-5.1 19-3.2v30c-6-1.9-12.6-.5-19 3.2-6.4-3.7-13-5.1-19-3.2V19Z"
            fill="#b67336"
            fillOpacity=".38"
          />
          <path
            d="M14 16.5c6-1.8 12-.5 18 3.1v29c-6-3.6-12-4.9-18-3.1v-29Z"
            fill="#fff8e7"
          />
          <path
            d="M50 16.5c-6-1.8-12-.5-18 3.1v29c6-3.6 12-4.9 18-3.1v-29Z"
            fill="#ffedc5"
          />
          <path d="M32 20v28" stroke="#b87942" strokeWidth="1.4" />
          <path
            d="M19 25c2.4-.1 4.8.4 7.2 1.5M19 31c2.4-.1 4.8.4 7.2 1.5M19 37c2.4-.1 4.8.4 7.2 1.5M38 26.5c2.4-1.1 4.8-1.6 7.2-1.5M38 32.5c2.4-1.1 4.8-1.6 7.2-1.5M38 38.5c2.4-1.1 4.8-1.6 7.2-1.5"
            stroke="#b77942"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <path d="M42 16.1v12l3-1.8 3 1v-11" fill="#bb7641" />
        </>
      ) : (
        <>
          <rect x="14" y="28" width="36" height="22" rx="4" fill="#f1edff" />
          <path d="M14 29h36v5H14z" fill="#d5caf5" />
          <g transform="rotate(-10 32 24)">
            <rect
              x="13"
              y="17"
              width="38"
              height="10"
              rx="2.5"
              fill="#faf7ff"
            />
            <path
              d="m17 17 6 10h7l-6-10h-7Zm15 0 6 10h7l-6-10h-7"
              fill="#594598"
            />
          </g>
          <path
            d="M21 39h22M21 44h14"
            stroke="#7964b4"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
        </>
      )}
    </svg>
  );
}

/** A tile is application identity; a compact symbol remains optically readable
 * in tabs/Dock. Installed icons and unknown applications keep the original path. */
export function AppIcon({
  app,
  presentation = "symbol",
}: {
  app: ApplicationCatalogEntry;
  presentation?: "symbol" | "tile";
}) {
  const identity = applicationIdentity(app);
  if (app.iconImage) return <img src={app.iconImage} alt="" />;
  if (identity)
    return presentation === "tile" ? (
      <ApplicationEmblem identity={identity} />
    ) : (
      <ApplicationSymbol identity={identity} />
    );
  const Icon = {
    layers: Layers2,
    document: FileText,
    globe: Globe,
    code: Braces,
    book: BookOpen,
    film: Film,
  }[app.icon];
  return <Icon aria-hidden />;
}
