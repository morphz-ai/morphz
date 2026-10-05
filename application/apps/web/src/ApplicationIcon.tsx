import { useId } from "react";
import { BookOpen, Braces, FileText, Film, Globe, Layers2 } from "lucide-react";
import type { ApplicationCatalogEntry } from "../../../packages/core/src/applications.js";
import {
  applicationIdentities,
  applicationIdentity,
  type ApplicationIdentity,
} from "./application-identity.js";

/** One application-drawer image for both launch surfaces, distinct from
 * workspace navigation. Its blue/violet field borrows the app identity palette. */
export function ApplicationLauncherIcon() {
  const id = useId();
  const field = `${id}-collection`;
  return (
    <svg
      viewBox="0 0 24 24"
      className="application-launcher-symbol"
      fill="none"
      stroke="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={field} x2=".75" y2="1">
          <stop stopColor={applicationIdentities.browser.field[0]} />
          <stop offset="1" stopColor={applicationIdentities.studio.field[1]} />
        </linearGradient>
      </defs>
      <rect width="24" height="24" rx="6" fill={`url(#${field})`} />
      {[7, 12, 17].flatMap((cy) =>
        [7, 12, 17].map((cx) => (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.3" fill="#ffffff" />
        )),
      )}
    </svg>
  );
}

function ApplicationEmblem({ identity }: { identity: ApplicationIdentity }) {
  // Every surface scales this same artwork; paint-server IDs stay instance-local.
  const id = useId();
  const field = `${id}-field`;
  const palette = applicationIdentities[identity];
  return (
    <svg
      viewBox="0 0 64 64"
      className="application-emblem"
      data-application-identity={identity}
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="none"
      strokeWidth="0"
    >
      <defs>
        <linearGradient
          id={field}
          x1="0"
          y1="0"
          x2="48"
          y2="64"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor={palette.field[0]} />
          <stop offset="1" stopColor={palette.field[1]} />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill={`url(#${field})`} />
      {identity === "browser" ? (
        <>
          <circle cx="32" cy="32" r="21" fill={palette.foreground[0]} />
          <path d="M43.5 20.5 35.5 35.5 28.5 28.5Z" fill={palette.field[1]} />
          <path
            d="M20.5 43.5 28.5 28.5 35.5 35.5Z"
            fill={palette.foreground[1]}
          />
        </>
      ) : identity === "reader" ? (
        <>
          <path
            d="M12 17.5c6-2.5 12.5-1.1 18.5 2.5v29.5c-6-3.6-12.5-5-18.5-2.5V17.5Z"
            fill={palette.foreground[0]}
          />
          <path
            d="M52 17.5c-6-2.5-12.5-1.1-18.5 2.5v29.5c6-3.6 12.5-5 18.5-2.5V17.5Z"
            fill={palette.foreground[1]}
          />
        </>
      ) : (
        <>
          <rect
            x="11"
            y="29"
            width="42"
            height="22"
            rx="4.5"
            fill={palette.foreground[0]}
          />
          <g transform="rotate(-9 32 22)">
            <rect
              x="10"
              y="15"
              width="42"
              height="11"
              rx="3"
              fill={palette.foreground[1]}
            />
            <path
              d="M17 15h7l6 11h-7l-6-11Zm17 0h7l6 11h-7l-6-11Z"
              fill={palette.field[1]}
            />
          </g>
        </>
      )}
    </svg>
  );
}

/** All sizes use the same application image, not a separately styled control
 * symbol. Presentation stays accepted for existing consumers; only their CSS
 * sets size. Author images and unknown applications keep the original path. */
export function AppIcon({
  app,
}: {
  app: ApplicationCatalogEntry;
  presentation?: "symbol" | "tile";
}) {
  return <ApplicationImage app={app} identity={applicationIdentity(app)} />;
}

/** Author images and declared fallback symbols need no UI-only manifest.
 * Trusted bundled consumers alone supply a verified built-in identity. */
export function ApplicationImage({
  app,
  identity,
}: {
  app: Pick<ApplicationCatalogEntry, "icon" | "iconImage">;
  identity?: ApplicationIdentity;
}) {
  if (app.iconImage) return <img src={app.iconImage} alt="" />;
  if (identity) return <ApplicationEmblem identity={identity} />;
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
