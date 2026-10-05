import {
  parseCognitiveAppRequest,
  type CognitiveAppRequestMap,
} from "../../../../packages/core/src/cognitive-app-api.js";
import { canonicalJsonBytes } from "../../../../packages/cognitive-app-sdk/src/domain-wire.js";
import { parseWireJson } from "../../../../packages/cognitive-app-sdk/src/protocol.js";
import {
  draftKey,
  requirePersistentDraftOwner,
  scopedStorage,
} from "../local-preferences.js";

type Connection = CognitiveAppRequestMap["connect"];
type PendingConnection = { requestSha: string; request: Connection };
type PreparedConnection = {
  request: Connection;
  recovered: boolean;
  acknowledge(): void;
  forgetRetry(): void;
};
const canonical = (value: unknown) =>
  new TextDecoder().decode(canonicalJsonBytes(value));

/** A refreshed grant does not mean an earlier creation failed. Keep the lookup
 * target separate from the immutable original request's ID and grant CAS. */
function intent(request: Connection) {
  const { connectionId, expectedGrantRevision, ...target } = request;
  void connectionId;
  void expectedGrantRevision;
  return canonical(target);
}

function pendingConnection(
  value: unknown,
  expectedIntent: string,
): PendingConnection {
  const detached = parseWireJson(value);
  if (
    detached === null ||
    typeof detached !== "object" ||
    Array.isArray(detached) ||
    Object.keys(detached).sort().join(",") !== "request,requestSha" ||
    !("request" in detached) ||
    !("requestSha" in detached) ||
    typeof detached.requestSha !== "string" ||
    !/^[a-f0-9]{64}$/.test(detached.requestSha)
  )
    throw new Error("连接重试记录已损坏，未准备连接请求。");
  const request = parseCognitiveAppRequest("connect", detached.request);
  if (intent(request) !== expectedIntent)
    throw new Error("连接重试记录与原目标不一致，未准备连接请求。");
  return { requestSha: detached.requestSha, request };
}

async function sha(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(canonicalJsonBytes(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Only prepares a Human-selected public DTO. No network, installation, grant,
 * connection creation or automatic retry occurs here. The caller separately
 * checks its current identity and requires explicit consent to retry recovery. */
async function connectionRetry(
  input: Connection,
  scope: string,
  signal: AbortSignal,
  create: boolean,
): Promise<PreparedConnection | null> {
  // Core's descriptor/budget guard detaches the whole carrier before any await.
  const candidate = parseCognitiveAppRequest("connect", input);
  const expectedIntent = intent(candidate);
  signal.throwIfAborted();
  const owner = requirePersistentDraftOwner();
  if (typeof scope !== "string" || !scope)
    throw new Error("连接身份尚未就绪，未准备连接请求。");
  const storage = scopedStorage(scope);
  const check = () => {
    signal.throwIfAborted();
    if (requirePersistentDraftOwner() !== owner)
      throw new Error("连接窗口身份已变化，未准备连接请求。");
  };
  const intentSha = await sha(JSON.parse(expectedIntent));
  check();
  const key = draftKey("cognitive-connection:" + intentSha);
  const verify = async (value: unknown) => {
    const pending = pendingConnection(value, expectedIntent);
    const digest = await sha(pending.request);
    check();
    if (digest !== pending.requestSha)
      throw new Error("连接重试记录的完整摘要不一致，未准备连接请求。");
    return pending;
  };
  let prior = storage.readLocalStrict(key);
  check();
  // Looking up a disabled/currently changed grant's original request is local
  // inspection only. Absence must not create an attempt or write a candidate.
  if (!prior.found && !create) return null;
  let recovered = prior.found;
  let pending: PendingConnection;
  if (prior.found) pending = await verify(prior.value);
  else {
    const requestSha = await sha(candidate);
    check();
    // A second preparation in this window can finish its hash first. Re-read
    // immediately before writing, never overwrite its original ID/CAS.
    prior = storage.readLocalStrict(key);
    check();
    if (prior.found) {
      recovered = true;
      pending = await verify(prior.value);
    } else {
      pending = { requestSha, request: candidate };
      storage.writeLocal(key, pending);
      check();
    }
  }
  const originalSha = pending.requestSha;
  const originalId = pending.request.connectionId;
  const originalRequest = canonical(pending.request);
  const saved = storage.readLocalStrict(key);
  check();
  if (!saved.found) throw new Error("无法保存连接重试标识，未准备连接请求。");
  const confirmed = await verify(saved.value);
  if (
    confirmed.requestSha !== originalSha ||
    confirmed.request.connectionId !== originalId ||
    canonical(confirmed.request) !== originalRequest
  )
    throw new Error("连接重试记录在准备期间变化，未准备连接请求。");
  // Hash verification is asynchronous; final strict read catches a replacement
  // that arrived during that await. Compare all original public fields, not ID.
  const final = storage.readLocalStrict(key);
  check();
  if (
    !final.found ||
    canonical(pendingConnection(final.value, expectedIntent)) !==
      canonical(confirmed)
  )
    throw new Error("连接重试记录在核验期间变化，未准备连接请求。");

  const clearOriginal = () => {
    storage.removeLocalStrict(key, (value) => {
      const kept = pendingConnection(value, expectedIntent);
      if (
        kept.requestSha !== originalSha ||
        kept.request.connectionId !== originalId ||
        canonical(kept.request) !== originalRequest
      )
        throw new Error("连接重试记录已被另一尝试替换，原记录未清理。");
      return true;
    });
  };
  return {
    request: parseCognitiveAppRequest("connect", confirmed.request),
    recovered,
    // A verified ACK can clean its captured old scope after presentation retires.
    acknowledge: clearOriginal,
    // This is NOT an ACK or rollback. Caller must separately require live Human
    // identity and explicit confirmation of the risk of another connection.
    forgetRetry() {
      check();
      clearOriginal();
    },
  };
}

export async function prepareCognitiveConnection(
  input: Connection,
  scope: string,
  signal: AbortSignal,
): Promise<PreparedConnection> {
  const prepared = await connectionRetry(input, scope, signal, true);
  if (!prepared) throw new Error("未准备连接请求。");
  return prepared;
}

/** Reads an existing local attempt; does not save missing records, generate a
 * connection ID, contact a Host, or interpret the current grant as authority. */
export function findCognitiveConnectionRetry(
  input: Connection,
  scope: string,
  signal: AbortSignal,
): Promise<PreparedConnection | null> {
  return connectionRetry(input, scope, signal, false);
}
