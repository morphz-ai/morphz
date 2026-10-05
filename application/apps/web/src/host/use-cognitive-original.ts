import { useEffect, useMemo, useRef, useState } from "react";
import { applicationCall } from "../application-transport.js";
import {
  cognitiveNavigationLocation,
  type CognitiveNavigationLocation,
} from "./cognitive-navigation-location.js";
import {
  createCognitiveObjectOwner,
  type CognitiveObjectOwnerPorts,
} from "./cognitive-object-owner.js";
import type { NavigationIdentity } from "./use-workspace-navigation-host.js";

export type CognitiveOriginal = Awaited<
  ReturnType<ReturnType<typeof createCognitiveObjectOwner>["readOriginal"]>
>;
type Result = {
  key: string;
  epoch: number;
  scope: string;
  incarnation: number;
} & (
  | { status: "ready"; value: CognitiveOriginal }
  | { status: "error"; message: string }
);
const ORIGINAL_BYTES = 256 * 1024;
const READ_DEADLINE_MS = 30_000;

/** Read lifecycle only. The existing Host owns navigation, recency and drafts.
 * No body enters preferences, no background polling or implicit latest read. */
export function useCognitiveOriginal({
  location,
  identity,
  navigationEpoch,
  isCurrent,
  call,
}: {
  location: CognitiveNavigationLocation | null | undefined;
  identity: NavigationIdentity;
  navigationEpoch: number;
  isCurrent: () => boolean;
  /** Current-Human transport seam for mounted acceptance, never guest input. */
  call?: CognitiveObjectOwnerPorts["call"];
}) {
  const request = useMemo(() => {
    try {
      const parsed = cognitiveNavigationLocation(location);
      return parsed?.kind === "original"
        ? { location: parsed, key: JSON.stringify(parsed), invalid: false }
        : { location: null, key: "", invalid: false };
    } catch {
      return { location: null, key: "invalid", invalid: true };
    }
  }, [location]);
  const scope = JSON.stringify([
    identity.centerId,
    identity.principalId,
    identity.csrfToken,
  ]);
  const [result, setResult] = useState<Result | null>(null);
  const [retry, setRetry] = useState(0);
  const seed = useRef<Result | null>(null);
  const current = useRef({
    scope,
    navigationEpoch,
    key: request.key,
    isCurrent,
    incarnation: 0,
  });
  const previous = current.current;
  const incarnation =
    previous.incarnation +
    Number(
      previous.scope !== scope ||
        previous.navigationEpoch !== navigationEpoch ||
        previous.key !== request.key,
    );
  current.current = {
    scope,
    navigationEpoch,
    key: request.key,
    isCurrent,
    incarnation,
  };
  if (
    seed.current &&
    (seed.current.scope !== scope || incarnation > seed.current.incarnation)
  )
    seed.current = null;
  const lifetime = useRef(0);
  const explicitReads = useRef(new Set<AbortController>());
  const authorizedReads = useRef(
    new WeakMap<CognitiveOriginal, { scope: string; lifetime: number }>(),
  );
  const owner = useMemo(
    () =>
      createCognitiveObjectOwner({
        call:
          call ??
          ((method, parameters, options) =>
            applicationCall(method, parameters, {
              ...options,
              identityGeneration: identity.csrfToken,
            })),
      }),
    [scope, call],
  );

  useEffect(() => {
    lifetime.current++;
    return () => {
      lifetime.current++;
      seed.current = null;
      for (const abort of explicitReads.current) abort.abort();
      explicitReads.current.clear();
    };
  }, [scope]);

  useEffect(() => {
    if (!request.location) return;
    const { key } = request;
    const epoch = navigationEpoch;
    if (
      seed.current?.key === key &&
      seed.current.epoch === epoch &&
      seed.current.scope === scope &&
      seed.current.incarnation === incarnation
    ) {
      if (current.current.isCurrent()) setResult(seed.current);
      seed.current = null;
      return;
    }
    const abort = new AbortController();
    let active = true;
    const expiresAt = performance.now() + READ_DEADLINE_MS;
    const currentRead = () =>
      active &&
      !abort.signal.aborted &&
      current.current.scope === scope &&
      current.current.key === key &&
      current.current.navigationEpoch === epoch &&
      current.current.incarnation === incarnation &&
      current.current.isCurrent();
    const timedOut = () => performance.now() >= expiresAt;
    const timeout = () => {
      if (currentRead())
        setResult({
          key,
          epoch,
          scope,
          incarnation,
          status: "error",
          message: "原件读取超时，请重试。",
        });
      abort.abort();
    };
    const deadline = setTimeout(timeout, READ_DEADLINE_MS);
    void owner
      .readOriginal(request.location.locator, ORIGINAL_BYTES, abort.signal)
      .then(
        (value) => {
          if (currentRead() && timedOut()) timeout();
          else if (currentRead())
            setResult({
              key,
              epoch,
              scope,
              incarnation,
              status: "ready",
              value,
            });
        },
        (error: unknown) => {
          if (currentRead() && timedOut()) timeout();
          else if (currentRead())
            setResult({
              key,
              epoch,
              scope,
              incarnation,
              status: "error",
              message:
                error instanceof Error ? error.message : "原件暂时无法读取。",
            });
        },
      )
      .finally(() => clearTimeout(deadline));
    return () => {
      active = false;
      clearTimeout(deadline);
      abort.abort();
    };
  }, [request.key, scope, navigationEpoch, retry, owner, incarnation]);

  const matching = (value: Result | null) =>
    value?.key === request.key &&
    value.epoch === navigationEpoch &&
    value.scope === scope &&
    value.incarnation === incarnation &&
    current.current.isCurrent();
  const selected = matching(result)
    ? result
    : matching(seed.current)
      ? seed.current
      : null;
  const value = selected?.status === "ready" ? selected.value : null;
  const requested = !!location && (request.invalid || !!request.location);
  return {
    requested,
    blocked: requested && !value,
    value,
    message: request.invalid
      ? "原件阅读位置无效，请重新打开历史引用。"
      : selected?.status === "error"
        ? selected.message
        : "",
    reload() {
      // Invalidate a late continuation synchronously, before effect cleanup.
      current.current.incarnation++;
      seed.current = null;
      setResult(null);
      setRetry((value) => value + 1);
    },
    async readOriginal(
      locator: Extract<
        CognitiveNavigationLocation,
        { kind: "original" }
      >["locator"],
      signal: AbortSignal,
    ) {
      const life = lifetime.current;
      if (current.current.scope !== scope || !current.current.isCurrent())
        throw new Error("原件读取范围已改变，请重新打开。");
      const abort = new AbortController();
      explicitReads.current.add(abort);
      const combined = AbortSignal.any([signal, abort.signal]);
      const expiresAt = performance.now() + READ_DEADLINE_MS;
      const timer = setTimeout(() => abort.abort(), READ_DEADLINE_MS);
      let cancelled!: () => void;
      const cancellation = new Promise<never>((_, reject) => {
        cancelled = () => reject(new Error("原件读取已取消或超时，请重试。"));
        combined.addEventListener("abort", cancelled, { once: true });
        if (combined.aborted) cancelled();
      });
      try {
        const value = await Promise.race([
          owner.readOriginal(locator, ORIGINAL_BYTES, combined),
          cancellation,
        ]);
        if (performance.now() >= expiresAt) {
          abort.abort();
          throw new Error("原件读取超时，请重试。");
        }
        if (
          combined.aborted ||
          current.current.scope !== scope ||
          lifetime.current !== life ||
          !current.current.isCurrent()
        )
          throw new Error("原件读取范围已改变，结果已丢弃。");
        authorizedReads.current.set(value, { scope, lifetime: life });
        return value;
      } finally {
        clearTimeout(timer);
        combined.removeEventListener("abort", cancelled);
        explicitReads.current.delete(abort);
      }
    },
    /** Called only after an authorized explicit open and the existing Host
     * navigation witness; never accepts author replies or restored bodies. */
    adopt(value: CognitiveOriginal, epoch: number) {
      const proof = authorizedReads.current.get(value);
      if (
        !proof ||
        proof.scope !== scope ||
        current.current.scope !== scope ||
        proof.lifetime !== lifetime.current ||
        !current.current.isCurrent() ||
        !Number.isSafeInteger(epoch) ||
        epoch < 0
      )
        return;
      authorizedReads.current.delete(value);
      const key = JSON.stringify({ kind: "original", locator: value.locator });
      seed.current = {
        key,
        epoch,
        scope,
        incarnation:
          current.current.incarnation +
          Number(
            current.current.key !== key ||
              current.current.navigationEpoch !== epoch,
          ),
        status: "ready",
        value,
      };
      setResult(seed.current);
    },
  };
}
