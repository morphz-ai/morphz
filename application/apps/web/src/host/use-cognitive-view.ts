import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { applicationCall } from "../application-transport.js";
import {
  cognitiveNavigationLocation,
  type CognitiveNavigationLocation,
} from "./cognitive-navigation-location.js";
import {
  createCognitiveViewOwner,
  cognitiveViewSourceForOwner,
  type CognitiveViewOwnerPorts,
  type CognitiveViewRead,
} from "./cognitive-view-owner.js";
import type { CognitiveAppViewUi } from "../../../../packages/core/src/cognitive-app-view-api.js";
import type { NavigationIdentity } from "./use-workspace-navigation-host.js";
import type { CognitiveWorkSurface } from "./work-surface.js";

const READ_DEADLINE_MS = 30_000;
type Status = "idle" | "loading" | "error" | CognitiveViewRead["status"];
type Result = {
  key: string;
  scope: string;
  epoch: number;
  generation: number;
  isCurrent(): boolean;
} & ({ read: CognitiveViewRead } | { error: string });
export type CognitiveViewLease = Readonly<{
  source: CognitiveAppViewUi;
  surface: Extract<CognitiveWorkSurface, { kind: "view" }>;
  isCurrent(): boolean;
}>;

/** Read lifecycle only, inside the original private navigation owner. The
 * caller supplies its real private-incarnation/currentProjection gate; these
 * props/effects never replace Human/HPA permission or a fresh router readUi.
 * No persisted body, second navigation store, implicit mutation or polling. */
export function useCognitiveView({
  location,
  identity,
  navigationEpoch,
  isCurrent,
  call,
}: {
  location: CognitiveNavigationLocation | null | undefined;
  identity: NavigationIdentity;
  navigationEpoch: number;
  isCurrent(): boolean;
  /** Controlled acceptance seam or the actual current-Human transport. */
  call?: CognitiveViewOwnerPorts["call"];
}) {
  const request = useMemo(() => {
    try {
      const parsed = cognitiveNavigationLocation(location);
      return parsed?.kind === "view"
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
  const owner = useMemo(() => {
    const identityGeneration = identity.csrfToken;
    return createCognitiveViewOwner({
      call:
        call ??
        ((method, parameters, options) =>
          applicationCall(method, parameters, {
            ...options,
            identityGeneration,
          })),
    });
  }, [scope, call]);
  const [result, setResult] = useState<Result | null>(null);
  const [retry, setRetry] = useState(0);
  const current = useRef({
    scope,
    epoch: navigationEpoch,
    key: request.key,
    owner,
    generation: 0,
    isCurrent,
  });
  const previous = current.current;
  const generation =
    previous.generation +
    Number(
      previous.scope !== scope ||
        previous.epoch !== navigationEpoch ||
        previous.key !== request.key ||
        previous.owner !== owner,
    );
  current.current = {
    scope,
    epoch: navigationEpoch,
    key: request.key,
    owner,
    generation,
    isCurrent,
  };
  const lifetime = useRef({ active: false, incarnation: 0 });
  const reads = useRef(new Set<AbortController>());

  // A same-scope cleanup/replay is a new lease, even if every prop is identical.
  // Layout cleanup retires captured references before passive-effect cleanup.
  useLayoutEffect(() => {
    lifetime.current.active = true;
    lifetime.current.incarnation++;
    return () => {
      lifetime.current.active = false;
      lifetime.current.incarnation++;
      for (const abort of reads.current) abort.abort();
      reads.current.clear();
    };
  }, [scope, navigationEpoch, request.key, owner, retry]);

  useEffect(() => {
    if (!request.location) return;
    const key = request.key,
      epoch = navigationEpoch,
      incarnation = lifetime.current.incarnation;
    const abort = new AbortController();
    reads.current.add(abort);
    let live = true;
    const expiresAt = performance.now() + READ_DEADLINE_MS;
    const ownerCurrent = () => {
      if (!live) return false;
      let active = false;
      try {
        active =
          lifetime.current.active &&
          lifetime.current.incarnation === incarnation &&
          current.current.scope === scope &&
          current.current.epoch === epoch &&
          current.current.key === key &&
          current.current.generation === generation &&
          current.current.isCurrent();
      } catch {
        /* The actual private owner can retire while evaluating its lease. */
      }
      if (!active) {
        live = false;
        abort.abort();
      }
      return active;
    };
    const readCurrent = () => !abort.signal.aborted && ownerCurrent();
    const premise = { key, scope, epoch, generation };
    const timeout = () => {
      if (readCurrent())
        setResult({
          ...premise,
          isCurrent: ownerCurrent,
          error: "应用界面读取超时，请重试。",
        });
      abort.abort();
    };
    const timer = setTimeout(timeout, READ_DEADLINE_MS);
    let cancelled!: () => void;
    const cancellation = new Promise<never>((_, reject) => {
      cancelled = () => reject(new Error("应用界面读取已取消。"));
      abort.signal.addEventListener("abort", cancelled, { once: true });
    });
    if (readCurrent()) {
      void Promise.race([
        owner.read(request.location.slot, abort.signal),
        cancellation,
      ])
        .then(
          (read) => {
            if (!readCurrent()) return;
            if (performance.now() >= expiresAt) timeout();
            else setResult({ ...premise, isCurrent: readCurrent, read });
          },
          (error: unknown) => {
            if (!readCurrent()) return;
            if (performance.now() >= expiresAt) timeout();
            else
              setResult({
                ...premise,
                isCurrent: ownerCurrent,
                error:
                  error instanceof Error
                    ? error.message
                    : "应用界面暂时无法读取。",
              });
          },
        )
        .finally(() => {
          clearTimeout(timer);
          abort.signal.removeEventListener("abort", cancelled);
        });
    } else {
      clearTimeout(timer);
      abort.signal.removeEventListener("abort", cancelled);
      // No pending race observes the cancellation when admission already failed.
      void cancellation.catch(() => undefined);
    }
    return () => {
      live = false;
      clearTimeout(timer);
      abort.signal.removeEventListener("abort", cancelled);
      abort.abort();
      reads.current.delete(abort);
    };
  }, [request.key, scope, navigationEpoch, retry, owner, generation]);

  const matching =
    !!result &&
    result.key === request.key &&
    result.scope === scope &&
    result.epoch === navigationEpoch &&
    result.generation === generation &&
    result.isCurrent();
  const selected = matching ? result : null;
  const read = selected && "read" in selected ? selected.read : null;
  const value = read?.status === "ready" ? read.source : null;
  const requested = request.invalid || !!request.location;
  const status: Status = !requested
    ? "idle"
    : request.invalid || (selected && "error" in selected)
      ? "error"
      : (read?.status ?? "loading");
  const message = request.invalid
    ? "应用窗口位置无效，请重新打开。"
    : selected && "error" in selected
      ? selected.error
      : read?.status === "absent"
        ? "此应用尚未打开界面。"
        : read?.status === "closed"
          ? "此应用窗口已关闭。"
          : read?.status === "unbound"
            ? "此应用窗口尚未绑定数据连接。"
            : "";
  return {
    requested,
    blocked: requested && !value,
    status,
    value,
    location: read?.location ?? null,
    message,
    reload() {
      // A saved callback from another scope/epoch cannot invalidate the new
      // owner or schedule reads under its identity. This is not permission;
      // the same actual private-owner gate still admits each explicit retry.
      if (
        !lifetime.current.active ||
        current.current.scope !== scope ||
        current.current.epoch !== navigationEpoch ||
        current.current.key !== request.key ||
        current.current.generation !== generation
      )
        return;
      try {
        if (!current.current.isCurrent()) return;
      } catch {
        return;
      }
      // Invalidate synchronously, not merely after React's effect cleanup.
      current.current.generation++;
      for (const abort of reads.current) abort.abort();
      setResult(null);
      setRetry((value) => value + 1);
    },
    /** A trusted router supplies a freshly authorized source, not author props.
     * A legitimate own save may advance its CAS. Each lease captures this exact
     * read owner and source; no mutable latest-source slot is shared by callers. */
    captureLease(
      authorizedSource: CognitiveAppViewUi,
    ): CognitiveViewLease | null {
      if (!value || !selected?.isCurrent()) return null;
      const source = cognitiveViewSourceForOwner(value, authorizedSource);
      if (!source || !selected.isCurrent()) return null;
      const surface = Object.freeze({
        kind: "view" as const,
        projectId: source.binding.projectId,
        viewId: source.view.id,
        connectionId: source.binding.connectionId,
        authority: source.authority,
      });
      return Object.freeze({ source, surface, isCurrent: selected.isCurrent });
    },
  };
}
