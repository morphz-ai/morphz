import {
  parseCognitiveAppViewRequest,
  type CognitiveAppViewRequestMap,
} from "./cognitive-app-view-api.js";

/** One bound Human HTML resource, not a generic resource/authority protocol. */
export type CognitiveAppViewResourceRequest =
  CognitiveAppViewRequestMap["readUi"];
export type CognitiveAppViewResource = {
  mime: "text/html; charset=utf-8";
  bytes: Uint8Array;
};
export const cognitiveAppViewResourcePrefix = "/api/cognitive-app-view/";
export const cognitiveAppViewResourceMime = "text/html; charset=utf-8";
export const maxCognitiveAppViewHtmlBytes = 1_000_000;

export function parseCognitiveAppViewResourceRequest(
  input: unknown,
): CognitiveAppViewResourceRequest {
  return parseCognitiveAppViewRequest("readUi", input);
}
export function cognitiveAppViewResourcePath(input: unknown): string {
  const request = parseCognitiveAppViewResourceRequest(input);
  return `${cognitiveAppViewResourcePrefix}${request.viewId}?expectedViewRevision=${request.expectedViewRevision}&expectedBindingRevision=${request.expectedBindingRevision}`;
}
export function parseCognitiveAppViewResourceURL(
  url: URL,
): CognitiveAppViewResourceRequest | null {
  if (
    url.pathname !== cognitiveAppViewResourcePrefix.slice(0, -1) &&
    !url.pathname.startsWith(cognitiveAppViewResourcePrefix)
  )
    return null;
  const path = /^\/api\/cognitive-app-view\/([A-Za-z0-9_-]{1,100})$/.exec(
    url.pathname,
  );
  const keys = ["expectedViewRevision", "expectedBindingRevision"] as const;
  if (
    !path ||
    url.hash ||
    url.username ||
    url.password ||
    url.searchParams.size !== 2 ||
    keys.some((key) => url.searchParams.getAll(key).length !== 1)
  )
    throw new Error("Invalid bound UI resource.");
  const values = keys.map((key) => {
    const value = url.searchParams.get(key)!;
    if (!/^[1-9]\d{0,15}$/.test(value))
      throw new Error("Invalid bound UI revision.");
    return Number(value);
  });
  return parseCognitiveAppViewResourceRequest({
    viewId: path[1],
    expectedViewRevision: values[0],
    expectedBindingRevision: values[1],
  });
}
/** Validate fatal UTF-8 without decoding/re-encoding or removing a leading BOM. */
export function parseCognitiveAppViewHtmlBytes(input: Uint8Array): Uint8Array {
  if (
    !(input instanceof Uint8Array) ||
    input.byteLength < 1 ||
    input.byteLength > maxCognitiveAppViewHtmlBytes
  )
    throw new Error("Invalid bound UI bytes.");
  const bytes = new Uint8Array(input);
  new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  return bytes;
}
export function cognitiveAppViewHtmlResource(
  html: string,
): CognitiveAppViewResource {
  if (typeof html !== "string") throw new Error("Invalid bound UI HTML.");
  const bytes = parseCognitiveAppViewHtmlBytes(new TextEncoder().encode(html));
  // No silently replaced unpaired surrogate can become a different document.
  if (
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) !==
    html
  )
    throw new Error("Invalid bound UI HTML.");
  return { mime: cognitiveAppViewResourceMime, bytes };
}
