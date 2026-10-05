import { parseWireJson } from "../../cognitive-app-sdk/src/protocol.js";
import {
  parseCognitiveAppViewResourceRequest,
  type CognitiveAppViewResourceRequest,
} from "./cognitive-app-view-resource.js";

/** Host document carrier only. The proof is transport correlation, not authority. */
export type CognitiveAppDocumentResourceRequest =
  CognitiveAppViewResourceRequest & {
    documentProof: string;
  };
export type CognitiveAppDocumentResource = {
  mime: "text/html; charset=utf-8";
  bytes: Uint8Array;
};
export const cognitiveAppDocumentResourcePrefix =
  "/api/cognitive-app-document/";
export const cognitiveAppDocumentResourceMime = "text/html; charset=utf-8";
/** Wrapper expansion is independent of the unchanged 1,000,000-byte author limit. */
export const maxCognitiveAppDocumentHtmlBytes = 1_500_000;

export function parseCognitiveAppDocumentProof(input: unknown): string {
  if (typeof input !== "string" || !/^[A-Za-z0-9_-]{22,128}$/.test(input))
    throw new Error("Invalid cognitive document proof.");
  return input;
}

export function parseCognitiveAppDocumentResourceRequest(
  input: unknown,
): CognitiveAppDocumentResourceRequest {
  // Inspect all own descriptors before spreading or reading any supplied field.
  const detached: unknown = JSON.parse(JSON.stringify(parseWireJson(input)));
  if (
    detached === null ||
    typeof detached !== "object" ||
    Array.isArray(detached)
  )
    throw new Error("Invalid cognitive document resource.");
  const { documentProof, ...cas } = detached as Record<string, unknown>;
  return {
    ...parseCognitiveAppViewResourceRequest(cas),
    documentProof: parseCognitiveAppDocumentProof(documentProof),
  };
}

export function cognitiveAppDocumentResourcePath(input: unknown): string {
  const request = parseCognitiveAppDocumentResourceRequest(input);
  return `${cognitiveAppDocumentResourcePrefix}${request.viewId}?expectedViewRevision=${request.expectedViewRevision}&expectedBindingRevision=${request.expectedBindingRevision}&documentProof=${request.documentProof}`;
}

export function parseCognitiveAppDocumentResourceURL(
  url: URL,
): CognitiveAppDocumentResourceRequest | null {
  if (
    url.pathname !== cognitiveAppDocumentResourcePrefix.slice(0, -1) &&
    !url.pathname.startsWith(cognitiveAppDocumentResourcePrefix)
  )
    return null;
  const path = /^\/api\/cognitive-app-document\/([A-Za-z0-9_-]{1,100})$/.exec(
    url.pathname,
  );
  const keys = [
    "expectedViewRevision",
    "expectedBindingRevision",
    "documentProof",
  ] as const;
  if (
    !path ||
    url.hash ||
    url.username ||
    url.password ||
    url.searchParams.size !== 3 ||
    keys.some((key) => url.searchParams.getAll(key).length !== 1)
  )
    throw new Error("Invalid cognitive document resource.");
  const revisions = keys.slice(0, 2).map((key) => {
    const value = url.searchParams.get(key)!;
    if (!/^[1-9]\d{0,15}$/.test(value))
      throw new Error("Invalid cognitive document revision.");
    return Number(value);
  });
  return parseCognitiveAppDocumentResourceRequest({
    viewId: path[1],
    expectedViewRevision: revisions[0],
    expectedBindingRevision: revisions[1],
    documentProof: url.searchParams.get("documentProof"),
  });
}

/** Validate and detach exact fatal UTF-8, including a leading BOM. */
export function parseCognitiveAppDocumentHtmlBytes(
  input: Uint8Array,
): Uint8Array {
  if (
    !(input instanceof Uint8Array) ||
    input.byteLength < 1 ||
    input.byteLength > maxCognitiveAppDocumentHtmlBytes
  )
    throw new Error("Invalid cognitive document bytes.");
  const bytes = new Uint8Array(input);
  new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  return bytes;
}

export function cognitiveAppDocumentHtmlResource(
  html: string,
): CognitiveAppDocumentResource {
  if (typeof html !== "string")
    throw new Error("Invalid cognitive document HTML.");
  const bytes = parseCognitiveAppDocumentHtmlBytes(
    new TextEncoder().encode(html),
  );
  if (
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) !==
    html
  )
    throw new Error("Invalid cognitive document HTML.");
  return { mime: cognitiveAppDocumentResourceMime, bytes };
}
