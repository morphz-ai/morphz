import type { ApplicationCatalogEntry } from "../../../packages/core/src/applications.js";

/** Application identity is independent of the host's selected accent palette.
 * An installed author's own image always takes precedence over bundled art. */
export const applicationIdentities = {
  browser: {
    id: "morphz.browser",
    view: "browser",
    field: ["#268bff", "#1655dd"],
    foreground: ["#ffffff", "#bfe3ff"],
    symbol: ["#246eea", "#78bdff"],
  },
  reader: {
    id: "morphz.reader",
    view: "reader",
    field: ["#ffab45", "#f9792d"],
    foreground: ["#ffffff", "#ffe3c5"],
    symbol: ["#ed842b", "#ffbc70"],
  },
  studio: {
    id: "morphz.script-studio",
    view: "script-studio",
    field: ["#a06cff", "#7050e8"],
    foreground: ["#ffffff", "#e7dcff"],
    symbol: ["#8659ec", "#c4a5ff"],
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
