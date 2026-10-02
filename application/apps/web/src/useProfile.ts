import { useCallback, useEffect, useRef, useState } from "react";
import {
  profileSnapshotSchema,
  profileAvatarSnapshotSchema,
  profileUpdateSchema,
  profileUpdateResultSchema,
  profileAvatarBytesSchema,
  profileHasConfiguredFields,
  normalizeAgentProfileData,
  normalizeHumanProfileData,
  type ProfileSnapshot,
  type ProfileSubject,
  type ProfileUpdate,
} from "../../../packages/core/src/profile.js";
import { applicationCall, RequestError } from "./application-transport.js";
import type { WorkspaceClient } from "./client.js";
import {
  ProfileAutosave,
  ProfileAutosaveConflictError,
} from "./profile-autosave.js";

type AvatarUrls = { original: string; poster: string };
export function useProfile(client: WorkspaceClient) {
  const key = `${client.boot?.centerId}:${client.boot?.principalId}:${client.boot?.csrfToken}`;
  // Bootstrap updates transport before React necessarily renders the new
  // client. Never let this scope's delayed edit borrow the next identity.
  const identityGeneration = client.boot?.csrfToken ?? "";
  const current = useRef(key);
  current.current = key;
  const mounted = useRef(true);
  const [, renderAutosave] = useState(0);
  const auto = useRef<{ key: string; controller: ProfileAutosave } | null>(
    null,
  );
  // Presentation-only intent for an enabled empty text control. It survives
  // editor unmounts, but never supplies Profile data or persistence authority.
  const textActivation = useRef<{
    key: string;
    agent: Set<string>;
    human: Set<string>;
  }>({ key, agent: new Set(), human: new Set() });
  if (textActivation.current.key !== key)
    textActivation.current = { key, agent: new Set(), human: new Set() };
  const [state, setState] = useState<{
    key: string;
    snapshot?: ProfileSnapshot;
    loading: boolean;
    error: string;
    accessDenied?: boolean;
  }>({ key, loading: true, error: "" });
  const [media, setMedia] = useState<{
    key: string;
    signature?: string;
    attempt?: number;
    human?: AvatarUrls;
    agent?: AvatarUrls;
    error?: string;
  }>({ key });
  const [mediaAttempt, retryMedia] = useState(0);
  const mediaFailed = useRef(false);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const requestKey = key,
      request = ++sequence.current;
    if (!client.online) return;
    setState((s) => ({
      ...(s.key === requestKey ? s : {}),
      key: requestKey,
      loading: true,
      error: "",
    }));
    try {
      const snapshot = profileSnapshotSchema.parse(
        await applicationCall("profile.read", {}, { identityGeneration }),
      );
      if (current.current !== requestKey || request !== sequence.current)
        return;
      setState({ key: requestKey, snapshot, loading: false, error: "" });
      if (mediaFailed.current) retryMedia((value) => value + 1);
      return snapshot;
    } catch (error) {
      if (current.current !== requestKey || request !== sequence.current)
        return;
      const accessDenied =
        error instanceof RequestError &&
        (error.status === 401 || error.status === 403);
      setState((s) => ({
        ...(accessDenied ? {} : s),
        key: requestKey,
        loading: false,
        // A transport failure is not proof that revoked access was restored.
        // Only a successful authorized read may reveal the cached editor again.
        accessDenied: accessDenied || s.accessDenied === true,
        error: error instanceof Error ? error.message : "资料暂时无法读取。",
      }));
      if (accessDenied) setMedia({ key: requestKey });
      throw error;
    }
  }, [key, identityGeneration, client.online]);
  useEffect(() => {
    setState({ key, loading: true, error: "" });
    if (client.online) void refresh().catch(() => {});
    return () => {
      sequence.current++;
    };
  }, [key, client.online, refresh]);
  const snapshot = state.key === key ? state.snapshot : undefined;
  const avatarSignature = snapshot
    ? `${snapshot.agent.id}:${snapshot.human.avatar.revision}:${snapshot.agent.avatar.revision}`
    : "";
  useEffect(() => {
    if (!snapshot || !client.online) return;
    let cancelled = false;
    const created: string[] = [];
    const read = async (
      subject: ProfileSubject,
    ): Promise<AvatarUrls | undefined> => {
      const avatar = snapshot[subject].avatar;
      if (!avatar.media) return;
      const values = await Promise.all(
        (["original", "poster"] as const).map(async (variant) => {
          return profileAvatarBytesSchema.parse(
            await applicationCall(
              "profile.avatar.read",
              {
                subject,
                revision: avatar.revision,
                variant,
              },
              { identityGeneration },
            ),
          );
        }),
      );
      if (cancelled || current.current !== key) return;
      const images = values.map((value) => {
        const url = URL.createObjectURL(
          new Blob([new Uint8Array(value.bytes)], { type: value.mime }),
        );
        created.push(url);
        return url;
      });
      return { original: images[0]!, poster: images[1]! };
    };
    void Promise.allSettled([read("human"), read("agent")]).then(
      ([human, agent]) => {
        if (!cancelled && current.current === key) {
          mediaFailed.current =
            human.status === "rejected" || agent.status === "rejected";
          setMedia({
            key,
            signature: avatarSignature,
            attempt: mediaAttempt,
            human: human.status === "fulfilled" ? human.value : undefined,
            agent: agent.status === "fulfilled" ? agent.value : undefined,
            error:
              human.status === "rejected" || agent.status === "rejected"
                ? "头像暂时无法读取，请重试。"
                : "",
          });
        }
      },
    );
    return () => {
      cancelled = true;
      created.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [key, identityGeneration, avatarSignature, client.online, mediaAttempt]);
  const assertScope = (requestKey: string) => {
    if (current.current !== requestKey || !mounted.current)
      throw new DOMException("身份已切换，旧操作结果已丢弃。", "AbortError");
  };
  async function save(command: ProfileUpdate) {
    command = profileUpdateSchema.parse(command);
    // Compare the same canonical intent that Host persists: empty optional
    // text means unset, not a conflicting save or an unknown receipt.
    if (command.subject === "human")
      command.data = normalizeHumanProfileData(command.data);
    else command.data = normalizeAgentProfileData(command.data);
    const requestKey = key;
    assertScope(requestKey);
    const receipt = profileUpdateResultSchema.parse(
      await applicationCall("profile.update", command, { identityGeneration }),
    );
    assertScope(requestKey);
    if (
      receipt.commandId !== command.commandId ||
      receipt.subject !== command.subject ||
      receipt.revision !== command.expectedRevision + 1 ||
      receipt.enabled !==
        (command.enabled === true && profileHasConfiguredFields(command.data))
    )
      throw new Error("保存回执不匹配，请用同一次操作重试。");
    const actual = await refresh();
    assertScope(requestKey);
    if (
      !actual ||
      actual[command.subject].revision < command.expectedRevision + 1
    )
      throw new Error("保存结果待核对，请用同一次操作重试。");
    if (
      JSON.stringify(actual[command.subject].data) !==
        JSON.stringify(command.data) ||
      actual[command.subject].enabled !== receipt.enabled
    )
      throw new ProfileAutosaveConflictError(
        "资料已再次变化，请重新读取后确认。",
      );
    return actual;
  }
  // Indirection keeps one queue for the authenticated scope, rather than one
  // queue per editor mount or render. Each RPC still checks the captured scope.
  const transport = useRef({ save, refresh });
  transport.current = { save, refresh };
  if (auto.current?.key !== key) {
    auto.current?.controller.dispose();
    const requestKey = key;
    auto.current = {
      key,
      controller: new ProfileAutosave({
        assertScope: () => assertScope(requestKey),
        save: (command) => transport.current.save(command),
        read: () => transport.current.refresh(),
        changed: () => {
          if (mounted.current && current.current === requestKey)
            renderAutosave((value) => value + 1);
        },
        isConflict: (error) =>
          error instanceof RequestError && error.status === 409,
      }),
    };
  }
  const autosave = auto.current.controller;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      autosave.cancelScheduled();
    };
  }, [autosave]);
  useEffect(() => {
    if (snapshot) autosave.hydrate(snapshot);
  }, [snapshot, autosave]);
  async function setAvatar(
    subject: ProfileSubject,
    file: File,
    commandId: string,
    expectedRevision: number,
  ) {
    const requestKey = key;
    const bytes = new Uint8Array(await file.arrayBuffer());
    assertScope(requestKey);
    const receipt = profileAvatarSnapshotSchema.parse(
      await applicationCall(
        "profile.avatar.set",
        {
          subject,
          commandId,
          expectedRevision,
          data: bytes,
        },
        { identityGeneration },
      ),
    );
    assertScope(requestKey);
    const actual = await refresh();
    assertScope(requestKey);
    if (
      receipt.revision !== expectedRevision + 1 ||
      !actual ||
      JSON.stringify(actual[subject].avatar) !== JSON.stringify(receipt)
    )
      throw new Error("头像保存结果待核对，请用同一次操作重试。");
  }
  async function clearAvatar(
    subject: ProfileSubject,
    commandId: string,
    expectedRevision: number,
  ) {
    const requestKey = key;
    assertScope(requestKey);
    const receipt = profileAvatarSnapshotSchema.parse(
      await applicationCall(
        "profile.avatar.clear",
        {
          subject,
          commandId,
          expectedRevision,
        },
        { identityGeneration },
      ),
    );
    assertScope(requestKey);
    const actual = await refresh();
    assertScope(requestKey);
    if (
      receipt.revision !== expectedRevision + 1 ||
      receipt.media !== null ||
      !actual ||
      JSON.stringify(actual[subject].avatar) !== JSON.stringify(receipt)
    )
      throw new Error("头像移除结果待核对，请用同一次操作重试。");
  }
  return {
    scope: key,
    interfaceScope: client.boot
      ? `${client.boot.centerId}:${client.boot.principalId}`
      : undefined,
    snapshot,
    textActivation: textActivation.current,
    autosave: autosave.state,
    edit: autosave.edit.bind(autosave),
    flush: autosave.flush.bind(autosave),
    retry: autosave.retry.bind(autosave),
    discard: autosave.discard.bind(autosave),
    resolveConflict: autosave.resolveConflict.bind(autosave),
    assertCurrentScope: () => assertScope(key),
    loading: state.key !== key || state.loading,
    error: state.key === key ? state.error : "",
    accessDenied: state.key === key && state.accessDenied === true,
    // Old object URLs may already have been revoked by an exact-version change.
    media:
      client.online &&
      media.key === key &&
      media.signature === avatarSignature &&
      media.attempt === mediaAttempt
        ? media
        : { key },
    refresh,
    save,
    setAvatar,
    clearAvatar,
  };
}
export type ProfileController = ReturnType<typeof useProfile>;
