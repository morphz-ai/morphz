import { useEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { FolderKey, X } from "lucide-react";
import { z } from "zod";
import {
  directoryGrantSchema,
  type DirectoryGrant,
} from "../../../packages/core/src/local-files.js";
import { applicationCall } from "./application-transport.js";
import { restoreInputToolFocus } from "./input-tool-focus.js";
import "./agent-directories.css";

export type DirectoryState = {
  scope: string;
  ready: boolean;
  grants: DirectoryGrant[];
};

/** Permissions belong to a conversation/workspace, never to an open viewer. */
export function AgentDirectories({
  projectId,
  conversationId,
  identity,
  previewTarget,
  disabled,
  onSelecting,
  onState,
  onError,
}: {
  projectId: string;
  conversationId: string;
  identity: string;
  previewTarget: HTMLElement | null;
  disabled: boolean;
  onSelecting(value: boolean): void;
  onState(value: DirectoryState): void;
  onError(message: string): void;
}) {
  const scope = `${projectId}:${conversationId}`;
  const [grants, setGrants] = useState<DirectoryGrant[]>([]);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const alive = useRef(true);
  const trigger = useRef<HTMLButtonElement>(null);
  const callbacks = useRef({ onState, onError });
  callbacks.current = { onState, onError };
  function publish(value: DirectoryGrant[]) {
    if (!alive.current) return;
    setGrants(value);
    setReady(true);
    callbacks.current.onState({ scope, ready: true, grants: value });
  }
  async function list() {
    return z
      .array(directoryGrantSchema)
      .parse(
        await applicationCall(
          "directories.list",
          { projectId, conversationId },
          { identityGeneration: identity },
        ),
      );
  }
  useEffect(() => {
    alive.current = true;
    callbacks.current.onState({ scope, ready: false, grants: [] });
    void list()
      .then(publish)
      .catch((e) => {
        if (alive.current) callbacks.current.onError(e.message);
      });
    return () => {
      alive.current = false;
    };
  }, [scope, identity]);
  async function choose() {
    const origin = trigger.current;
    // The native sheet blurs the renderer. Suspend auto-collapse before IPC,
    // not after its result: otherwise this component is already unmounted.
    flushSync(() => {
      setBusy(true);
      onSelecting(true);
      callbacks.current.onState({ scope, ready: false, grants });
    });
    try {
      if (!window.morphzDesktop?.directories)
        throw new Error("当前桌面尚未加载目录授权，请重开应用。");
      await window.morphzDesktop.directories.choose(projectId, conversationId);
      publish(await list());
    } catch (e) {
      if (alive.current) {
        callbacks.current.onError((e as Error).message);
        callbacks.current.onState({ scope, ready, grants });
      }
    } finally {
      if (alive.current) setBusy(false);
      onSelecting(false);
      restoreInputToolFocus(origin);
    }
  }
  async function revoke(grant: DirectoryGrant) {
    const origin = trigger.current;
    setBusy(true);
    callbacks.current.onState({ scope, ready: false, grants });
    try {
      publish(
        z
          .array(directoryGrantSchema)
          .parse(
            await applicationCall(
              "directories.revoke",
              { projectId, conversationId, grantId: grant.grantId },
              { identityGeneration: identity },
            ),
          ),
      );
    } catch (e) {
      if (alive.current) {
        callbacks.current.onError((e as Error).message);
        callbacks.current.onState({ scope, ready, grants });
      }
    } finally {
      // The revoked chip disappears. Return to its still-valid directory
      // tool after React has re-enabled it, without taking focus back from
      // typing or a different scope.
      flushSync(() => {
        if (alive.current) setBusy(false);
      });
      restoreInputToolFocus(origin);
    }
  }
  return (
    <>
      <button
        ref={trigger}
        className="icon-button"
        type="button"
        aria-label="授权 Agent 读写目录"
        title="授权 Agent 读写目录（仅当前对话与工作空间）"
        disabled={disabled || busy || grants.length >= 8}
        onClick={() => void choose()}
      >
        <FolderKey />
      </button>
      {previewTarget &&
        grants.length > 0 &&
        createPortal(
          <div className="agent-directories" aria-label="此对话的目录读写权限">
            <span className="directory-scope">Agent 可读写</span>
            {grants.map((grant) => (
              <span className="directory-grant" key={grant.grantId}>
                <span
                  title={`${grant.path}\n仅当前对话与工作空间，持续有效直到撤销；不是消息附件。`}
                >
                  {grant.name}
                </span>
                <button
                  type="button"
                  className="icon-button"
                  disabled={disabled || busy}
                  aria-label={`撤销 ${grant.name} 的读写权限`}
                  title="撤销权限，包括进行中工作的后续文件访问"
                  onClick={() => void revoke(grant)}
                >
                  <X />
                </button>
              </span>
            ))}
          </div>,
          previewTarget,
        )}
    </>
  );
}
