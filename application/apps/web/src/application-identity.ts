import type { ApplicationCatalogEntry } from "../../../packages/core/src/applications.js";

/** Application identity is independent of the host's selected accent palette.
 * An installed author's own image always takes precedence over bundled art. */
export const applicationIdentities = {
  browser: {
    id: "morphz.browser",
    view: "browser",
    field: ["#3997e9", "#2854af"],
    symbol: ["#2769b6", "#86c8ff"],
  },
  reader: {
    id: "morphz.reader",
    view: "reader",
    field: ["#f6cf85", "#ed9c56"],
    symbol: ["#99602e", "#f3c58e"],
  },
  studio: {
    id: "morphz.script-studio",
    view: "script-studio",
    field: ["#9581e9", "#6152b9"],
    symbol: ["#7756b5", "#c4b0ff"],
  },
} as const;

export type ApplicationIdentity = keyof typeof applicationIdentities;

export function applicationIdentity(
  app: ApplicationCatalogEntry,
): ApplicationIdentity | undefined {
  if (app.iconImage || app.ui.type !== "builtin") return undefined;
  const view = app.ui.view;
  return (Object.keys(applicationIdentities) as ApplicationIdentity[]).find(
    (name) => {
      const identity = applicationIdentities[name];
      return identity.id === app.id && identity.view === view;
    },
  );
}
