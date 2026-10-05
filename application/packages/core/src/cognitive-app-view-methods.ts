import type {
  CognitiveAppViewMethod,
  CognitiveAppViewRequestMap,
  CognitiveAppViewResponseMap,
} from "./cognitive-app-view-api.js";

/** Human presentation ingress only, separate from domain/guest operations. */
export const cognitiveAppViewApplicationMethods = Object.freeze([
  "cognitive-app-views.locate",
  "cognitive-app-views.launch",
  "cognitive-app-views.bind",
  "cognitive-app-views.read",
  "cognitive-app-views.read-ui",
  "cognitive-app-views.save",
  "cognitive-app-views.close",
] as const);
export const cognitiveAppViewApplicationRoutes = Object.freeze({
  "cognitive-app-views.locate": {
    method: "locate",
    path: "/api/platform/cognitive-app-views/locate",
  },
  "cognitive-app-views.launch": {
    method: "launch",
    path: "/api/platform/cognitive-app-views/launch",
  },
  "cognitive-app-views.bind": {
    method: "bind",
    path: "/api/platform/cognitive-app-views/bind",
  },
  "cognitive-app-views.read": {
    method: "read",
    path: "/api/platform/cognitive-app-views/read",
  },
  "cognitive-app-views.read-ui": {
    method: "readUi",
    path: "/api/platform/cognitive-app-views/read-ui",
  },
  "cognitive-app-views.save": {
    method: "save",
    path: "/api/platform/cognitive-app-views/save",
  },
  "cognitive-app-views.close": {
    method: "close",
    path: "/api/platform/cognitive-app-views/close",
  },
} as const satisfies Record<
  (typeof cognitiveAppViewApplicationMethods)[number],
  { method: CognitiveAppViewMethod; path: string }
>);
for (const route of Object.values(cognitiveAppViewApplicationRoutes))
  Object.freeze(route);
export function cognitiveAppViewApplicationRoute(method: string) {
  return Object.hasOwn(cognitiveAppViewApplicationRoutes, method)
    ? cognitiveAppViewApplicationRoutes[
        method as keyof typeof cognitiveAppViewApplicationRoutes
      ]
    : null;
}
export type CognitiveAppViewApplicationMethod =
  (typeof cognitiveAppViewApplicationMethods)[number];
export type CognitiveAppViewApplicationRequest<
  M extends CognitiveAppViewApplicationMethod,
> =
  CognitiveAppViewRequestMap[(typeof cognitiveAppViewApplicationRoutes)[M]["method"]];
export type CognitiveAppViewApplicationResponse<
  M extends CognitiveAppViewApplicationMethod,
> =
  CognitiveAppViewResponseMap[(typeof cognitiveAppViewApplicationRoutes)[M]["method"]];
