import { useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight, Plus, X } from "lucide-react";
import {
  parseCognitiveAppRequest,
  type CognitiveAppCatalogDto,
  type CognitiveAppRegisteredDescriptionDto,
  type CognitiveAppRequestMap,
} from "../../../../../packages/core/src/cognitive-app-api.js";
import {
  applicationManifestSchema,
  type ApplicationManifest,
} from "../../../../../packages/core/src/applications.js";
import {
  parseCognitiveAppDefinition,
  parseUiInstallJson,
  protocolLimits,
  type CognitiveAppDefinition,
} from "../../../../../packages/cognitive-app-sdk/src/protocol.js";
import { ApplicationImage } from "../../ApplicationIcon.js";
import type { WorkspaceClient } from "../../client.js";
import { prepareCognitiveInstallation } from "../../data/cognitive-installation-retry.js";
import {
  findCognitiveConnectionRetry,
  prepareCognitiveConnection,
} from "../../data/cognitive-connection-retry.js";
import { useModal } from "../../useModal.js";
import "./CognitiveAppManager.css";

type Metadata = CognitiveAppCatalogDto["versions"][number];
type Identity = { centerId: string; principalId: string; csrfToken: string };
export type CognitiveAppManagerProps = {
  catalog: Pick<CognitiveAppCatalogDto, "versions" | "connections">;
  management: WorkspaceClient["cognitiveManagement"];
  identity: Identity;
  onClose(): void;
};
type Notice = { kind: "error" | "saved" | "warning"; text: string };
type ConnectionAttempt = {
  key: string;
  request: CognitiveAppRequestMap["connect"];
  prepared: Awaited<ReturnType<typeof prepareCognitiveConnection>>;
  acknowledged: boolean;
  pending: boolean;
};
type Ticket = {
  controller: AbortController;
  epoch: number;
  identity: string;
  kind: "read" | "write";
  dispatchedWrite: boolean;
  selection?: string;
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
};
const keyOf = (entry: Metadata) =>
  JSON.stringify([entry.appId, entry.version, entry.definitionHash]);
const installationLabel = {
  active: "已安装",
  disabled: "安装已停用",
  unavailable: "安装不可用",
} as const;
const connectionLabel = {
  active: "已启用",
  disabled: "已停用",
  unavailable: "不可用",
} as const;
const effectLabel = { read: "读取", write: "写入", execute: "执行" } as const;
const scopeLabel = { project: "当前项目", objects: "指定原件" } as const;
function accessLabel(entry: Metadata) {
  return entry.grant === null
    ? "尚未允许数据访问"
    : entry.grant.state === "active"
      ? "已允许数据访问"
      : "数据访问权限已关闭";
}

/** This is a consumer of the authenticated owner, not a second directory or
 * permission authority. Identity retirement and access refresh are distinct:
 * an empty refreshed catalogue hides private previews but does not cancel ACKs.
 */
export function CognitiveAppManager({
  catalog,
  management,
  identity,
  onClose,
}: CognitiveAppManagerProps) {
  const headingId = useId();
  const identityKey = JSON.stringify([
    identity.centerId,
    identity.principalId,
    identity.csrfToken,
  ]);
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const lifetime = useRef({ active: false, epoch: 0, identity: identityKey });
  const latest = useRef({ catalog, management });
  const pending = useRef<Ticket | null>(null);
  const selection = useRef<string | null>(null);
  const [mode, setMode] = useState<"registered" | "add">("registered");
  const [addMode, setAddMode] = useState<"files" | "register">("files");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    identity: string;
    key: string;
    value: CognitiveAppRegisteredDescriptionDto;
  } | null>(null);
  const [busy, setBusy] = useState<"read" | "write" | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [definition, setDefinition] = useState<CognitiveAppDefinition | null>(
    null,
  );
  const [manifest, setManifest] = useState<ApplicationManifest | null>(null);
  const [definitionName, setDefinitionName] = useState("");
  const [manifestName, setManifestName] = useState("");
  const [registration, setRegistration] = useState({
    appId: "",
    version: "",
    definitionHash: "",
  });
  const [serviceId, setServiceId] = useState("");
  const [dataAuthorityId, setDataAuthorityId] = useState("");
  const [installed, setInstalled] = useState(false);
  const [formIdentity, setFormIdentity] = useState(identityKey);
  const attemptRef = useRef<ConnectionAttempt | null>(null);
  const [connectionAttempt, setConnectionAttempt] =
    useState<ConnectionAttempt | null>(null);
  const [forgetConfirmation, setForgetConfirmation] = useState(false);
  useModal(dialog, heading);
  useLayoutEffect(() => {
    latest.current = { catalog, management };
  });
  useLayoutEffect(() => {
    const previous = pending.current;
    if (previous && previous.identity !== identityKey) {
      previous.controller.abort();
      clearTimeout(previous.timer);
      pending.current = null;
    }
    lifetime.current = {
      active: true,
      epoch: lifetime.current.epoch + 1,
      identity: identityKey,
    };
    selection.current = null;
    setSelectedKey(null);
    setPreview(null);
    setDefinition(null);
    setManifest(null);
    setDefinitionName("");
    setManifestName("");
    setRegistration({ appId: "", version: "", definitionHash: "" });
    setServiceId("");
    setDataAuthorityId("");
    setInstalled(false);
    setNotice(null);
    setBusy(null);
    setFormIdentity(identityKey);
    attemptRef.current = null;
    setConnectionAttempt(null);
    setForgetConfirmation(false);
    return () => {
      lifetime.current.active = false;
      lifetime.current.epoch++;
      const ticket = pending.current;
      if (ticket) {
        clearTimeout(ticket.timer);
        // A protected catalogue refresh can unmount this visual consumer
        // after the authenticated owner has received a genuine write ACK.
        // It must not masquerade as an explicit caller cancellation.
        if (!ticket.dispatchedWrite) {
          ticket.controller.abort();
          pending.current = null;
        }
      }
    };
  }, [identityKey]);
  const selected = catalog.versions.find(
    (entry) => keyOf(entry) === selectedKey,
  );
  const description =
    selected && preview?.identity === identityKey && preview.key === selectedKey
      ? preview.value
      : null;
  const writing = busy === "write";
  useLayoutEffect(() => {
    const ticket = pending.current;
    if (
      ticket?.kind === "read" &&
      ticket.selection &&
      !catalog.versions.some((entry) => keyOf(entry) === ticket.selection)
    )
      ticket.controller.abort();
  }, [catalog]);

  function live(ticket: Ticket, allowAborted = false) {
    const current = lifetime.current;
    return (
      current.active &&
      current.epoch === ticket.epoch &&
      current.identity === ticket.identity &&
      ticket.identity === identityKey &&
      pending.current === ticket &&
      (allowAborted || !ticket.controller.signal.aborted) &&
      (!ticket.selection ||
        (selection.current === ticket.selection &&
          (ticket.kind === "write" ||
            latest.current.catalog.versions.some(
              (entry) => keyOf(entry) === ticket.selection,
            ))))
    );
  }
  function check(ticket: Ticket) {
    if (performance.now() >= ticket.deadline) ticket.controller.abort();
    if (!live(ticket)) throw new Error("操作已取消。");
  }
  function begin(kind: Ticket["kind"], exactKey?: string) {
    if (
      !lifetime.current.active ||
      lifetime.current.identity !== identityKey ||
      pending.current?.kind === "write"
    )
      return null;
    pending.current?.controller.abort();
    if (pending.current) clearTimeout(pending.current.timer);
    const controller = new AbortController();
    const ticket: Ticket = {
      controller,
      epoch: lifetime.current.epoch,
      identity: identityKey,
      kind,
      dispatchedWrite: false,
      selection: exactKey,
      deadline: performance.now() + 30000,
      timer: setTimeout(() => controller.abort(), 30000),
    };
    pending.current = ticket;
    setBusy(kind);
    setNotice(null);
    return ticket;
  }
  function finish(ticket: Ticket) {
    clearTimeout(ticket.timer);
    if (
      pending.current === ticket &&
      lifetime.current.active &&
      lifetime.current.epoch === ticket.epoch
    ) {
      pending.current = null;
      setBusy(null);
    }
  }
  function report(ticket: Ticket, error: unknown) {
    if (!live(ticket, true)) return;
    // Host errors are already public safe DTOs; parser errors need not expose
    // raw declarations or executable HTML in the interface.
    setNotice({
      kind: "error",
      text: ticket.controller.signal.aborted
        ? "等待已取消或超时；已提交的操作不会回滚，请核对原操作。"
        : error instanceof Error && "code" in error
          ? error.message
          : "操作未完成，请检查文件、标识和当前权限后再试。",
    });
  }
  async function bounded<T>(ticket: Ticket, work: () => Promise<T>) {
    check(ticket);
    return new Promise<T>((resolve, reject) => {
      const signal = ticket.controller.signal;
      let settled = false;
      const finishWait = (complete: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        complete();
      };
      const abort = () => finishWait(() => reject(new Error("操作已取消。")));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) return abort();
      try {
        Promise.resolve(work()).then(
          (value) => finishWait(() => resolve(value)),
          (error: unknown) => finishWait(() => reject(error)),
        );
      } catch (error) {
        finishWait(() => reject(error));
      }
    });
  }
  function manage<T>(ticket: Ticket, work: () => Promise<T>) {
    check(ticket);
    // The authenticated owner already bounds dispatch + refresh. Its deadline
    // can return a known ACK with refreshed:false; an earlier UI timer would
    // mislabel that deadline as explicit caller cancellation and lose the ACK.
    clearTimeout(ticket.timer);
    ticket.deadline = Number.POSITIVE_INFINITY;
    return bounded(ticket, () => {
      // No old closure may dispatch after a local identity change/unmount.
      check(ticket);
      if (ticket.kind === "write") ticket.dispatchedWrite = true;
      return work();
    });
  }
  function close() {
    const ticket = pending.current;
    if (ticket && !ticket.dispatchedWrite) ticket.controller.abort();
    onClose();
  }
  function cancelRead() {
    if (pending.current?.kind !== "read") return;
    pending.current.controller.abort();
    clearTimeout(pending.current.timer);
    pending.current = null;
    setBusy(null);
  }
  function switchMode(next: typeof mode) {
    if (pending.current?.kind === "write") return;
    cancelRead();
    setMode(next);
    setNotice(null);
  }
  function switchAddMode(next: typeof addMode) {
    if (pending.current?.kind === "write") return;
    cancelRead();
    setAddMode(next);
    setNotice(null);
  }
  async function select(entry: Metadata) {
    if (pending.current?.kind === "write") return;
    const key = keyOf(entry);
    if (!latest.current.catalog.versions.some((item) => keyOf(item) === key))
      return;
    selection.current = key;
    setSelectedKey(key);
    setPreview(null);
    setServiceId("");
    setDataAuthorityId("");
    setForgetConfirmation(false);
    const ticket = begin("read", key);
    if (!ticket) return;
    try {
      const request = parseCognitiveAppRequest("describe", {
        mode: "registered-management",
        appId: entry.appId,
        version: entry.version,
        expectedDefinitionHash: entry.definitionHash,
      });
      if (!("mode" in request)) throw new Error("定义请求无效。");
      const value = await manage(ticket, () =>
        latest.current.management.describeRegistered(
          request,
          ticket.controller.signal,
        ),
      );
      check(ticket);
      if (
        value.definition.id !== entry.appId ||
        value.definition.version !== entry.version ||
        value.definitionHash !== entry.definitionHash
      )
        throw new Error("定义已变化。");
      setPreview({ identity: identityKey, key, value });
    } catch (error) {
      report(ticket, error);
    } finally {
      finish(ticket);
    }
  }
  async function mutate<M extends "grant" | "connectionState">(
    method: M,
    input: CognitiveAppRequestMap[M],
  ) {
    const entry = latest.current.catalog.versions.find(
      (item) => keyOf(item) === selection.current,
    );
    if (!entry || !description || keyOf(entry) !== selectedKey) return;
    const ticket = begin("write", keyOf(entry));
    if (!ticket) return;
    try {
      const request = parseCognitiveAppRequest(method, input);
      const api = latest.current.management;
      // Each branch stays typed by the existing method's own request/ACK.
      const result =
        method === "grant"
          ? await manage(ticket, () =>
              api.grant(
                parseCognitiveAppRequest("grant", request),
                ticket.controller.signal,
              ),
            )
          : await manage(ticket, () =>
              api.connectionState(
                parseCognitiveAppRequest("connectionState", request),
                ticket.controller.signal,
              ),
            );
      check(ticket);
      setNotice({
        kind: result.refreshed ? "saved" : "warning",
        text: result.refreshed ? "已保存" : "已保存，目录刷新失败。",
      });
    } catch (error) {
      report(ticket, error);
    } finally {
      finish(ticket);
    }
  }
  function showAttempt(
    entry: Metadata,
    prepared: Awaited<ReturnType<typeof prepareCognitiveConnection>>,
    pending: boolean,
  ) {
    const attempt: ConnectionAttempt = {
      key: keyOf(entry),
      request: parseCognitiveAppRequest("connect", prepared.request),
      prepared,
      acknowledged: false,
      pending,
    };
    attemptRef.current = attempt;
    setConnectionAttempt(attempt);
    setForgetConfirmation(false);
    return attempt;
  }
  function connectionInput(connectionId: string) {
    if (!selected) return null;
    return parseCognitiveAppRequest("connect", {
      appId: selected.appId,
      version: selected.version,
      expectedDefinitionHash: selected.definitionHash,
      ...(selected.grant
        ? { expectedGrantRevision: selected.grant.revision }
        : {}),
      connectionId,
      expectedRevision: 0,
      serviceId,
      dataAuthorityId,
    });
  }
  async function findConnection() {
    if (!selected || !description) return;
    const entry = latest.current.catalog.versions.find(
      (item) => keyOf(item) === selectedKey,
    );
    if (!entry) return;
    const ticket = begin("read", keyOf(entry));
    if (!ticket) return;
    try {
      // Pure local lookup: no candidate UUID, record creation or Host call.
      const input = connectionInput("local_lookup");
      if (!input) return;
      const prepared = await bounded(ticket, () =>
        findCognitiveConnectionRetry(
          input,
          `${identity.centerId}:${identity.principalId}`,
          ticket.controller.signal,
        ),
      );
      check(ticket);
      if (!prepared) {
        setNotice({
          kind: "warning",
          text: "本窗口没有这个目标的重试记录；这不证明原请求未提交。",
        });
        return;
      }
      showAttempt(entry, prepared, false);
      setNotice({
        kind: "warning",
        text: "已找到原连接请求；请核对原参数后按原请求重试。",
      });
    } catch (error) {
      report(ticket, error);
    } finally {
      finish(ticket);
    }
  }
  async function connect(
    input: CognitiveAppRequestMap["connect"],
    original?: ConnectionAttempt,
  ) {
    const entry = latest.current.catalog.versions.find(
      (item) => keyOf(item) === selectedKey,
    );
    if (
      !entry ||
      !description ||
      (original && (original.key !== selectedKey || original.acknowledged)) ||
      (!original &&
        (entry.installationState !== "active" ||
          entry.grant?.state !== "active"))
    )
      return;
    const ticket = begin("write", keyOf(entry));
    if (!ticket) return;
    try {
      const requested = parseCognitiveAppRequest("connect", input);
      const prepared = await bounded(ticket, () =>
        prepareCognitiveConnection(
          requested,
          `${identity.centerId}:${identity.principalId}`,
          ticket.controller.signal,
        ),
      );
      check(ticket);
      const request = parseCognitiveAppRequest("connect", prepared.request);
      const changedOriginal =
        original &&
        JSON.stringify(request) !== JSON.stringify(original.request);
      const attempt = showAttempt(entry, prepared, false);
      if ((!original && prepared.recovered) || changedOriginal) {
        setNotice({
          kind: "warning",
          text: changedOriginal
            ? "本机原请求已变化；请重新核对，尚未发送连接请求。"
            : "已找到原连接请求；请核对原参数后按原请求重试。",
        });
        return;
      }
      attempt.pending = true;
      setConnectionAttempt({ ...attempt });
      const result = await manage(ticket, () =>
        latest.current.management.connect(request, ticket.controller.signal),
      );
      // The authentic owner ACK may arrive after private refresh unmounted UI.
      // Cleanup still belongs to the original captured scope and request.
      let cleared = true;
      try {
        prepared.acknowledge();
      } catch {
        cleared = false;
      }
      if (!live(ticket)) return;
      const confirmed = { ...attempt, acknowledged: true, pending: false };
      attemptRef.current = confirmed;
      setConnectionAttempt(confirmed);
      setForgetConfirmation(false);
      setNotice({
        kind: cleared && result.refreshed ? "saved" : "warning",
        text: !cleared
          ? "连接操作已确认，本机重试记录未能清理；请勿重复创建连接。"
          : result.refreshed
            ? "连接操作已确认"
            : "连接操作已确认，目录刷新失败。",
      });
    } catch (error) {
      report(ticket, error);
    } finally {
      if (
        live(ticket, true) &&
        attemptRef.current &&
        !attemptRef.current.acknowledged
      ) {
        const attempt = { ...attemptRef.current, pending: false };
        attemptRef.current = attempt;
        setConnectionAttempt(attempt);
      }
      finish(ticket);
    }
  }
  async function readFile(kind: "definition" | "manifest", file?: File) {
    if (!file || pending.current?.kind === "write") return;
    const ticket = begin("read");
    if (!ticket) return;
    // A rejected replacement cannot leave a previously selected valid file
    // looking as though it were the newly submitted carrier.
    setInstalled(false);
    if (kind === "definition") {
      setDefinition(null);
      setDefinitionName("");
      setManifest(null);
      setManifestName("");
    } else {
      setManifest(null);
      setManifestName("");
    }
    try {
      const max =
        kind === "definition"
          ? protocolLimits.definitionBytes
          : 8 * 1024 * 1024;
      if (file.size > max) throw new Error("文件超过限制。");
      const bytes = await bounded(ticket, () => file.arrayBuffer());
      check(ticket);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const parsed: unknown = JSON.parse(text);
      if (kind === "definition") {
        const value = parseCognitiveAppDefinition(parsed);
        check(ticket);
        setDefinition(value);
        setDefinitionName(file.name);
      } else {
        const value = applicationManifestSchema.parse(
          parseUiInstallJson(parsed),
        );
        if (value.ui.type !== "sandbox") throw new Error("不是独立界面包。");
        check(ticket);
        setManifest(value);
        setManifestName(file.name);
      }
    } catch (error) {
      report(ticket, error);
    } finally {
      finish(ticket);
    }
  }
  async function install() {
    const ticket = begin("write");
    if (!ticket) return;
    let acknowledged = false;
    try {
      const input: CognitiveAppRequestMap["install"] =
        addMode === "register"
          ? parseCognitiveAppRequest("install", {
              mode: "register-installed",
              ...registration,
              commandId: crypto.randomUUID(),
            })
          : definition?.ui === null
            ? parseCognitiveAppRequest("install", { definition })
            : parseCognitiveAppRequest("install", {
                definition,
                manifest,
                commandId: crypto.randomUUID(),
              });
      check(ticket);
      const prepared = await bounded(ticket, () =>
        prepareCognitiveInstallation(
          input,
          `${identity.centerId}:${identity.principalId}`,
          ticket.controller.signal,
        ),
      );
      check(ticket);
      const request = parseCognitiveAppRequest("install", prepared.request);
      const result = await manage(ticket, () =>
        latest.current.management.install(request, ticket.controller.signal),
      );
      acknowledged = true;
      // This cleanup belongs to the exact captured installation/scope, not to
      // the lifetime of its now possibly unmounted visual presentation.
      try {
        prepared.acknowledge();
      } catch {
        if (live(ticket)) {
          setInstalled(true);
          setNotice({
            kind: "warning",
            text: "应用已安装，本机操作标识未能清理，请勿重复安装。",
          });
        }
        return;
      }
      if (!live(ticket)) return;
      setInstalled(true);
      setNotice({
        kind: result.refreshed ? "saved" : "warning",
        text: result.refreshed
          ? "已接入，尚未新增数据访问权限。"
          : "已接入，目录刷新失败；尚未新增数据访问权限。",
      });
    } catch (error) {
      if (!acknowledged) report(ticket, error);
    } finally {
      finish(ticket);
    }
  }
  const canInstall =
    !busy &&
    !installed &&
    (addMode === "register"
      ? Boolean(
          registration.appId &&
          registration.version &&
          registration.definitionHash,
        )
      : Boolean(definition && (definition.ui === null || manifest)));
  const selectedAttempt =
    selected && connectionAttempt?.key === selectedKey
      ? connectionAttempt
      : null;
  const unknownConnection =
    selectedAttempt && !selectedAttempt.acknowledged ? selectedAttempt : null;
  const sameFormAttempt =
    selectedAttempt?.request.serviceId === serviceId &&
    selectedAttempt.request.dataAuthorityId === dataAuthorityId;
  async function forgetConnection() {
    const attempt = attemptRef.current;
    if (
      !attempt ||
      attempt.acknowledged ||
      attempt.pending ||
      busy ||
      !forgetConfirmation ||
      attempt.key !== selectedKey ||
      !lifetime.current.active ||
      lifetime.current.identity !== identityKey ||
      !latest.current.catalog.versions.some(
        (entry) => keyOf(entry) === attempt.key,
      )
    )
      return;
    const ticket = begin("read", attempt.key);
    if (!ticket) return;
    try {
      // A timed-out original signal cannot remain a permanent local lock.
      // Re-read without creating/sending, then compare the complete original.
      const kept = await bounded(ticket, () =>
        findCognitiveConnectionRetry(
          attempt.request,
          `${identity.centerId}:${identity.principalId}`,
          ticket.controller.signal,
        ),
      );
      check(ticket);
      if (
        attemptRef.current !== attempt ||
        !kept ||
        JSON.stringify(kept.request) !== JSON.stringify(attempt.request)
      )
        throw new Error("原请求已变化。");
      // Explicit local risk confirmation, never a server ACK or rollback.
      kept.forgetRetry();
      attemptRef.current = null;
      setConnectionAttempt(null);
      setForgetConfirmation(false);
      setNotice({
        kind: "warning",
        text: "已放弃本机重试记录；未撤销任何连接。",
      });
    } catch {
      if (live(ticket, true))
        setNotice({
          kind: "error",
          text: "未能清理原本机记录；没有撤销连接，也没有创建新连接。",
        });
    } finally {
      finish(ticket);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="create-dialog cognitive-app-manager"
      aria-labelledby={headingId}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <header>
        <h2 id={headingId} ref={heading} tabIndex={-1}>
          管理应用
        </h2>
        <button
          type="button"
          className="icon-button"
          aria-label="关闭应用管理"
          onClick={close}
        >
          <X />
        </button>
      </header>
      {formIdentity === identityKey && (
        <>
          <nav
            className="cognitive-app-manager-modes"
            aria-label="应用管理分类"
          >
            <button
              type="button"
              aria-pressed={mode === "registered"}
              disabled={writing}
              onClick={() => switchMode("registered")}
            >
              已接入
            </button>
            <button
              type="button"
              aria-pressed={mode === "add"}
              disabled={writing}
              onClick={() => switchMode("add")}
            >
              <Plus />
              添加应用
            </button>
          </nav>
          {notice && (
            <p
              className="cognitive-app-manager-notice"
              data-kind={notice.kind}
              role={notice.kind === "error" ? "alert" : "status"}
            >
              {notice.text}
            </p>
          )}
          <div className="cognitive-app-manager-body" aria-busy={busy !== null}>
            {mode === "registered" && unknownConnection && (
              <section
                className="cognitive-app-manager-uncertain"
                aria-label="原连接请求"
              >
                <h3>连接结果待核对</h3>
                <dl>
                  {[
                    ["应用", unknownConnection.request.appId],
                    ["版本", unknownConnection.request.version],
                    [
                      "定义摘要",
                      unknownConnection.request.expectedDefinitionHash,
                    ],
                    ["服务标识", unknownConnection.request.serviceId],
                    ["数据保存方", unknownConnection.request.dataAuthorityId],
                    ["连接标识", unknownConnection.request.connectionId],
                    [
                      "原权限修订",
                      unknownConnection.request.expectedGrantRevision ??
                        "未指定",
                    ],
                    ["原连接修订", unknownConnection.request.expectedRevision],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
                <p>
                  重试会提交完整原请求；如果原请求尚未提交，仍可能创建连接。
                </p>
                <div className="cognitive-app-manager-action-row">
                  <button
                    type="button"
                    className="secondary-action"
                    disabled={Boolean(busy) || !description}
                    onClick={() =>
                      void connect(unknownConnection.request, unknownConnection)
                    }
                  >
                    按原请求重试
                  </button>
                  <button
                    type="button"
                    className="secondary-action"
                    disabled={Boolean(busy)}
                    onClick={() => setForgetConfirmation(true)}
                  >
                    不再重试
                  </button>
                </div>
                {forgetConfirmation && (
                  <div
                    className="cognitive-app-manager-forget"
                    role="group"
                    aria-label="确认放弃本机重试"
                  >
                    <p>
                      原请求可能已经提交。放弃本机重试记录不会撤销旧连接；再次创建可能产生第二条连接。
                    </p>
                    <div className="cognitive-app-manager-action-row">
                      <button
                        type="button"
                        className="secondary-action"
                        disabled={Boolean(busy)}
                        onClick={() => void forgetConnection()}
                      >
                        确认放弃本机重试
                      </button>
                      <button
                        type="button"
                        className="secondary-action"
                        disabled={Boolean(busy)}
                        onClick={() => setForgetConfirmation(false)}
                      >
                        保留原记录
                      </button>
                    </div>
                  </div>
                )}
              </section>
            )}
            {mode === "registered" ? (
              <div className="cognitive-app-manager-layout">
                <section
                  className="cognitive-app-manager-directory"
                  aria-label="已接入应用"
                >
                  {catalog.versions.length ? (
                    <ul>
                      {catalog.versions.map((entry) => (
                        <li key={keyOf(entry)}>
                          <button
                            type="button"
                            aria-pressed={selectedKey === keyOf(entry)}
                            disabled={writing}
                            onClick={() => void select(entry)}
                          >
                            <span className="cognitive-app-manager-image">
                              <ApplicationImage app={entry} />
                            </span>
                            <span>
                              <strong>{entry.title}</strong>
                              <small>
                                {entry.version} · {accessLabel(entry)}
                              </small>
                              {entry.installationState !== "active" && (
                                <small>
                                  {installationLabel[entry.installationState]}
                                </small>
                              )}
                            </span>
                            <ChevronRight />
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="cognitive-app-manager-empty">尚未接入应用</p>
                  )}
                </section>
                <section
                  className="cognitive-app-manager-detail"
                  aria-label="应用详情"
                >
                  {selected ? (
                    <>
                      <div className="cognitive-app-manager-identity">
                        <span className="cognitive-app-manager-image">
                          <ApplicationImage app={selected} />
                        </span>
                        <div>
                          <h3>{selected.title}</h3>
                          <p>
                            {selected.version} ·{" "}
                            {installationLabel[selected.installationState]}
                          </p>
                        </div>
                      </div>
                      {description ? (
                        <>
                          <DefinitionDetails
                            definition={description.definition}
                          />
                          <section
                            className="cognitive-app-manager-section"
                            aria-label="数据访问权限"
                          >
                            <h4>数据访问权限</h4>
                            <div className="cognitive-app-manager-action-row">
                              <p>{accessLabel(selected)}</p>
                              <button
                                type="button"
                                className="secondary-action"
                                disabled={
                                  Boolean(busy) ||
                                  selected.installationState !== "active"
                                }
                                onClick={() =>
                                  void mutate("grant", {
                                    appId: selected.appId,
                                    version: selected.version,
                                    expectedRevision:
                                      selected.grant?.revision ?? 0,
                                    state:
                                      selected.grant?.state === "active"
                                        ? "disabled"
                                        : "active",
                                  })
                                }
                              >
                                {selected.grant?.state === "active"
                                  ? "关闭数据访问"
                                  : "允许数据访问"}
                              </button>
                            </div>
                            <p className="cognitive-app-manager-hint">
                              仅允许在本人获权范围内使用这些能力；不改变任务批准方式。
                            </p>
                          </section>
                          <section
                            className="cognitive-app-manager-section"
                            aria-label="数据连接"
                          >
                            <h4>数据连接</h4>
                            {catalog.connections
                              .filter(
                                (connection) =>
                                  connection.appId === selected.appId,
                              )
                              .map((connection) => (
                                <article
                                  className="cognitive-app-manager-connection"
                                  key={connection.connectionId}
                                >
                                  <dl>
                                    <div>
                                      <dt>服务标识</dt>
                                      <dd>{connection.serviceId}</dd>
                                    </div>
                                    <div>
                                      <dt>数据保存方</dt>
                                      <dd>{connection.dataAuthorityId}</dd>
                                    </div>
                                    <div>
                                      <dt>连接</dt>
                                      <dd title={connection.connectionId}>
                                        {connection.connectionId}
                                      </dd>
                                    </div>
                                  </dl>
                                  <div className="cognitive-app-manager-action-row">
                                    <p>{connectionLabel[connection.state]}</p>
                                    <button
                                      type="button"
                                      className="secondary-action"
                                      disabled={
                                        Boolean(busy) ||
                                        (connection.state !== "active" &&
                                          (selected.installationState !==
                                            "active" ||
                                            selected.grant?.state !== "active"))
                                      }
                                      onClick={() =>
                                        void mutate("connectionState", {
                                          appId: selected.appId,
                                          version: selected.version,
                                          expectedDefinitionHash:
                                            selected.definitionHash,
                                          ...(selected.grant
                                            ? {
                                                expectedGrantRevision:
                                                  selected.grant.revision,
                                              }
                                            : {}),
                                          connectionId: connection.connectionId,
                                          expectedRevision: connection.revision,
                                          state:
                                            connection.state === "active"
                                              ? "disabled"
                                              : "active",
                                        })
                                      }
                                    >
                                      {connection.state === "active"
                                        ? "停用连接"
                                        : "启用连接"}
                                    </button>
                                  </div>
                                </article>
                              ))}
                            {!catalog.connections.some(
                              (connection) =>
                                connection.appId === selected.appId,
                            ) && (
                              <p className="cognitive-app-manager-hint">
                                尚未建立连接
                              </p>
                            )}
                            <details className="cognitive-app-manager-connect">
                              <summary>建立连接</summary>
                              <form
                                onSubmit={(event) => {
                                  event.preventDefault();
                                  if (
                                    !selected.grant ||
                                    selected.grant.state !== "active"
                                  )
                                    return;
                                  try {
                                    const input = connectionInput(
                                      crypto.randomUUID(),
                                    );
                                    if (input) void connect(input);
                                  } catch {
                                    setNotice({
                                      kind: "error",
                                      text: "连接标识无效，尚未发送连接请求。",
                                    });
                                  }
                                }}
                              >
                                <label>
                                  服务标识
                                  <input
                                    value={serviceId}
                                    required
                                    maxLength={200}
                                    disabled={writing}
                                    autoComplete="off"
                                    onChange={(event) => {
                                      setServiceId(event.target.value);
                                      if (attemptRef.current?.acknowledged) {
                                        attemptRef.current = null;
                                        setConnectionAttempt(null);
                                      }
                                    }}
                                  />
                                </label>
                                <label>
                                  数据保存方标识
                                  <input
                                    value={dataAuthorityId}
                                    required
                                    maxLength={200}
                                    disabled={writing}
                                    autoComplete="off"
                                    onChange={(event) => {
                                      setDataAuthorityId(event.target.value);
                                      if (attemptRef.current?.acknowledged) {
                                        attemptRef.current = null;
                                        setConnectionAttempt(null);
                                      }
                                    }}
                                  />
                                </label>
                                <p className="cognitive-app-manager-hint">
                                  使用服务提供方给出的公开标识；连接地址与凭据须由宿主预先配置。
                                </p>
                                <div className="cognitive-app-manager-action-row">
                                  <button
                                    className="secondary-action"
                                    type="submit"
                                    disabled={
                                      Boolean(busy) ||
                                      sameFormAttempt ||
                                      !serviceId ||
                                      !dataAuthorityId ||
                                      selected.installationState !== "active" ||
                                      selected.grant?.state !== "active"
                                    }
                                  >
                                    建立连接
                                  </button>
                                  <button
                                    type="button"
                                    className="secondary-action"
                                    disabled={
                                      Boolean(busy) ||
                                      !serviceId ||
                                      !dataAuthorityId
                                    }
                                    onClick={() => void findConnection()}
                                  >
                                    查看原重试记录
                                  </button>
                                </div>
                              </form>
                            </details>
                          </section>
                        </>
                      ) : (
                        <p className="cognitive-app-manager-empty">
                          {busy === "read"
                            ? "正在读取定义…"
                            : "请选择该应用以读取定义"}
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="cognitive-app-manager-empty">
                      选择应用，查看能力与数据访问权限
                    </p>
                  )}
                </section>
              </div>
            ) : (
              <section
                className="cognitive-app-manager-add"
                aria-label="添加应用"
              >
                <div className="cognitive-app-manager-add-modes">
                  <button
                    type="button"
                    aria-pressed={addMode === "files"}
                    disabled={writing}
                    onClick={() => switchAddMode("files")}
                  >
                    从文件安装
                  </button>
                  <button
                    type="button"
                    aria-pressed={addMode === "register"}
                    disabled={writing}
                    onClick={() => switchAddMode("register")}
                  >
                    登记已安装应用
                  </button>
                </div>
                <form
                  key={addMode}
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (canInstall) void install();
                  }}
                >
                  {addMode === "files" ? (
                    <>
                      <label>
                        应用定义 JSON
                        <input
                          type="file"
                          accept="application/json,.json"
                          disabled={Boolean(busy)}
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            event.target.value = "";
                            void readFile("definition", file);
                          }}
                        />
                      </label>
                      {definitionName && (
                        <p className="cognitive-app-manager-hint">
                          {definitionName}
                        </p>
                      )}
                      {definition?.ui && (
                        <>
                          <label>
                            界面包 JSON
                            <input
                              type="file"
                              accept="application/json,.json"
                              disabled={Boolean(busy)}
                              onChange={(event) => {
                                const file = event.target.files?.[0];
                                event.target.value = "";
                                void readFile("manifest", file);
                              }}
                            />
                          </label>
                          {manifestName && (
                            <p className="cognitive-app-manager-hint">
                              {manifestName}
                            </p>
                          )}
                        </>
                      )}
                      {definition && (
                        <div className="cognitive-app-manager-install-preview">
                          <h3>
                            {definition.title}{" "}
                            <small>{definition.version}</small>
                          </h3>
                          <DefinitionDetails definition={definition} />
                          {definition.ui && (
                            <p className="cognitive-app-manager-hint">
                              此应用包含可执行界面代码；安装仅保存已选择的精确版本。
                            </p>
                          )}
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <label>
                        应用标识
                        <input
                          value={registration.appId}
                          required
                          maxLength={81}
                          autoComplete="off"
                          disabled={writing}
                          onChange={(event) => {
                            setInstalled(false);
                            setRegistration({
                              ...registration,
                              appId: event.target.value,
                            });
                          }}
                        />
                      </label>
                      <label>
                        版本
                        <input
                          value={registration.version}
                          required
                          maxLength={100}
                          autoComplete="off"
                          placeholder="1.0.0"
                          disabled={writing}
                          onChange={(event) => {
                            setInstalled(false);
                            setRegistration({
                              ...registration,
                              version: event.target.value,
                            });
                          }}
                        />
                      </label>
                      <label>
                        定义 SHA-256
                        <input
                          value={registration.definitionHash}
                          required
                          minLength={64}
                          maxLength={64}
                          autoComplete="off"
                          spellCheck={false}
                          disabled={writing}
                          onChange={(event) => {
                            setInstalled(false);
                            setRegistration({
                              ...registration,
                              definitionHash: event.target.value,
                            });
                          }}
                        />
                      </label>
                      <p className="cognitive-app-manager-hint">
                        使用明确交付的应用标识、版本及完整定义哈希，不读取他人界面字节。
                      </p>
                    </>
                  )}
                  <div className="cognitive-app-manager-add-actions">
                    <button
                      type="submit"
                      className="primary"
                      disabled={!canInstall}
                    >
                      {writing
                        ? "正在接入…"
                        : installed
                          ? "已接入"
                          : addMode === "register"
                            ? "登记应用"
                            : "安装应用"}
                    </button>
                  </div>
                </form>
              </section>
            )}
          </div>
        </>
      )}
    </dialog>
  );
}

function DefinitionDetails({
  definition,
}: {
  definition: CognitiveAppDefinition;
}) {
  return (
    <section className="cognitive-app-manager-definition" aria-label="应用能力">
      {definition.description && <p>{definition.description}</p>}
      <ul>
        {definition.operations.map((operation) => (
          <li key={operation.id}>
            <strong>{operation.title}</strong>
            <span>
              {effectLabel[operation.effect]} · {scopeLabel[operation.scope]}
            </span>
            {operation.description && <p>{operation.description}</p>}
          </li>
        ))}
      </ul>
      <p className="cognitive-app-manager-hint">
        {definition.ui ? "包含独立界面" : "无独立界面"}
        {definition.harness
          ? ` · 执行方式 ${definition.harness.id} ${definition.harness.version}`
          : " · 使用默认执行方式"}
      </p>
    </section>
  );
}
