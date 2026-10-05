import {
  parseCognitiveAppRequest,
  type CognitiveAppRequestMap,
} from "../../../../packages/core/src/cognitive-app-api.js";
import type { JsonValue } from "../../../../packages/cognitive-app-sdk/src/protocol.js";
import {
  draftKey,
  requirePersistentDraftOwner,
  scopedStorage,
} from "../local-preferences.js";

type RetryIdentity = { requestSha: string; commandId: string };

/** Match domain-wire's deterministic key order, but only over the detached Core
 * installation snapshot. Its valid UI carrier can exceed the wire's 512 KiB
 * budget; re-parsing it as an ordinary domain request would reject legal HTML.
 */
function canonicalInstallation(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(canonicalInstallation).join(",")}]`;
  const object = value as { readonly [key: string]: JsonValue };
  return `{${Object.keys(object)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalInstallation(object[key]!)}`,
    )
    .join(",")}}`;
}

function retryIdentity(value: unknown, requestSha: string): RetryIdentity {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "commandId,requestSha"
  )
    throw new Error("安装重试记录已损坏，未发送安装请求。");
  const identity = value as Record<string, unknown>;
  if (
    identity.requestSha !== requestSha ||
    typeof identity.commandId !== "string" ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(identity.commandId)
  )
    throw new Error("安装重试记录与请求不一致，未发送安装请求。");
  return { requestSha, commandId: identity.commandId };
}

/** Prepare only a Human-selected request. This leaf never submits, installs,
 * grants or connects; the caller separately guards its current Human identity.
 * Persist metadata, never the selected definition/HTML or credentials.
 */
export async function prepareCognitiveInstallation(
  input: CognitiveAppRequestMap["install"],
  scope: string,
  signal: AbortSignal,
): Promise<{
  request: CognitiveAppRequestMap["install"];
  acknowledge(): void;
}> {
  const request = parseCognitiveAppRequest("install", input);
  signal.throwIfAborted();
  if (request.commandId === undefined) return { request, acknowledge() {} }; // Original headless contract, no ID.

  requirePersistentDraftOwner();
  if (!scope) throw new Error("安装身份尚未就绪，未发送安装请求。");
  const storage = scopedStorage(scope);
  // Exclude exactly the top-level candidate ID. Nested properties, schema keys
  // and literal HTML remain part of the full installation identity.
  const { commandId, ...identity } = request;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalInstallation(identity)),
  );
  signal.throwIfAborted();
  requirePersistentDraftOwner();
  const requestSha = Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
  const key = draftKey("cognitive-installation:" + requestSha);
  const prior = storage.readLocalStrict(key);
  const pending = prior.found
    ? retryIdentity(prior.value, requestSha)
    : { requestSha, commandId };
  if (!prior.found) storage.writeLocal(key, pending);
  const saved = storage.readLocalStrict(key);
  if (
    !saved.found ||
    retryIdentity(saved.value, requestSha).commandId !== pending.commandId
  )
    throw new Error("无法保存安装重试标识，未发送安装请求。");
  signal.throwIfAborted();
  requirePersistentDraftOwner();

  return {
    request: { ...request, commandId: pending.commandId },
    acknowledge() {
      const current = storage.readLocalStrict(key);
      if (!current.found) return;
      if (
        retryIdentity(current.value, requestSha).commandId === pending.commandId
      )
        storage.removeLocal(key);
    },
  };
}
