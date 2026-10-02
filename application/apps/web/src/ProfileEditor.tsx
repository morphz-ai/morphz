import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { Camera, ChevronRight } from "lucide-react";
import {
  defaultAgentProfile,
  defaultHumanProfile,
  profileCustomStyleEnabled,
  avatarMaximumBytes,
  profileHasConfiguredFields,
  type AgentProfileData,
  type HumanProfileData,
  type ProfileSubject,
} from "../../../packages/core/src/profile.js";
import { ProfileAvatar, type ProfileAvatarState } from "./ProfileAvatar.js";
import { HumanAvatar } from "./HumanAvatar.js";
import type { ProfileController } from "./useProfile.js";
import { PersistentDetails } from "./PersistentDetails.js";
import { RequestError } from "./application-transport.js";

const traits = [
  {
    key: "humor",
    label: "幽默",
    low: "克制",
    high: "风趣",
    values: [
      "不开玩笑",
      "偶尔一点",
      "轻松一点",
      "适度幽默",
      "活泼风趣",
      "很有趣",
    ],
  },
  {
    key: "rigor",
    label: "严谨",
    low: "轻松",
    high: "考究",
    values: [
      "轻松表达",
      "简明判断",
      "说明要点",
      "有理有据",
      "细致核查",
      "深入论证",
    ],
  },
  {
    key: "warmth",
    label: "亲和",
    low: "沉静",
    high: "温暖",
    values: ["沉静", "平和", "自然", "亲切", "温暖", "很有陪伴感"],
  },
  {
    key: "verbosity",
    label: "详略",
    low: "简洁",
    high: "详尽",
    values: [
      "一句话优先",
      "尽量简短",
      "重点清楚",
      "适度展开",
      "细致解释",
      "详尽说明",
    ],
  },
] as const;
const styles = [
  { value: "natural", label: "自然" },
  { value: "concise", label: "干练" },
  { value: "thoughtful", label: "细腻" },
  { value: "direct", label: "直率" },
] as const;

export function ProfileEditor({
  profile,
  subject,
  state = "idle",
  stateLabel,
  allowMotion = true,
  onBusy,
}: {
  profile: ProfileController;
  subject: ProfileSubject;
  state?: ProfileAvatarState;
  stateLabel?: string;
  allowMotion?: boolean;
  onBusy?: (busy: boolean) => void;
}) {
  const actual = profile.snapshot?.[subject];
  const auto = profile.autosave[subject];
  const data: AgentProfileData | HumanProfileData =
    auto.data ??
    actual?.data ??
    (subject === "agent" ? defaultAgentProfile : defaultHumanProfile);
  const enabled = auto.enabled ?? actual?.enabled ?? false;
  const textIntent = useRef({ data, enabled });
  textIntent.current = { data, enabled };
  const [avatarBusy, setBusy] = useState(false);
  const [avatarError, setError] = useState("");
  const [avatarConflict, setConflict] = useState<"avatar">();
  const [editingName, setEditingName] = useState(false);
  const [editingAddress, setEditingAddress] = useState(false);
  const [compositionValues, setCompositionValues] = useState<
    Partial<Record<"name" | "preferredAddress", string>>
  >({});
  const activeTextEdit = useRef(new Set<"name" | "preferredAddress">());
  const editEpoch = useRef(0);
  const composingText = useRef(new Set<"name" | "preferredAddress">());
  const blurredComposition = useRef(new Set<"name" | "preferredAddress">());
  const busy = avatarBusy || auto.saving;
  const conflict = avatarConflict || auto.conflict;
  const error = avatarError || auto.error;
  const activateText = profile.textActivation[subject];
  // Like the save queue, an intermediate empty name retains the last
  // confirmed name; only explicitly ending an empty edit clears it.
  const hasConfiguration = (next: AgentProfileData | HumanProfileData) =>
    profileHasConfiguredFields({
      ...next,
      name:
        next.name === null
          ? null
          : next.name.trim() || actual?.data.name || null,
    });
  const configured = hasConfiguration(data);
  // Retained choices with enabled=false are an explicit opt-out, not a
  // request to activate the whole Profile when another field is selected.
  const canActivate = () =>
    textIntent.current.enabled ||
    (!hasConfiguration(textIntent.current.data) &&
      (subject === "human" || actual?.revision === 0));
  const Heading = subject === "agent" ? "h3" : "h2";
  const headingText = subject === "agent" ? "设定" : "个人资料";
  const avatarPending = useRef<
    | {
        file: File;
        commandId: string;
        expectedRevision: number;
      }
    | undefined
  >(undefined);
  const clearPending = useRef<
    { commandId: string; expectedRevision: number } | undefined
  >(undefined);
  const fileInput = useRef<HTMLInputElement>(null);
  const id = useId();
  // An in-flight save must not interrupt typing or a slider gesture. Avatar
  // writes still have their independent, versioned permission boundary.
  const editable =
    !!actual?.available && actual.editable && !avatarBusy && !conflict;
  const urls = profile.media[subject];
  const avatar = actual?.avatar;
  const animated = (avatar?.media?.frames ?? 1) > 1;
  useEffect(() => {
    onBusy?.(busy);
    return () => onBusy?.(false);
  }, [busy, onBusy]);
  const change = (
    update:
      | AgentProfileData
      | HumanProfileData
      | ((
          current: AgentProfileData | HumanProfileData,
        ) => AgentProfileData | HumanProfileData),
    nextEnabled = textIntent.current.enabled,
    delay = 0,
    allowEmpty = false,
  ) => {
    setError("");
    const next =
      typeof update === "function" ? update(textIntent.current.data) : update;
    const configured = hasConfiguration(next);
    const effectiveEnabled =
      subject === "agent" || configured || allowEmpty ? nextEnabled : false;
    textIntent.current = { data: next, enabled: effectiveEnabled };
    profile.edit(subject, next, effectiveEnabled, delay);
  };
  const textChange = (
    field: "name" | "preferredAddress" | "customStyle",
    value: string,
  ) => {
    if (field !== "customStyle" && !activeTextEdit.current.has(field)) return;
    if (field !== "customStyle" && composingText.current.has(field)) {
      // Provisional IME text is an editing draft, not consent to persist a
      // temporary empty name/address or partial composition.
      setCompositionValues((current) => ({ ...current, [field]: value }));
      return;
    }
    const firstValue =
      !!value.trim() &&
      canActivate() &&
      (activateText.has(field) || !hasConfiguration(textIntent.current.data));
    if (value.trim()) activateText.delete(field);
    change(
      (current) => ({ ...current, [field]: value }),
      firstValue ? true : textIntent.current.enabled,
      450,
      true,
    );
  };
  const flushText = () => void profile.flush(subject).catch(() => {});
  const selectCustomStyle = (checked: boolean) => {
    if (checked && canActivate()) activateText.add("customStyle");
    else activateText.delete("customStyle");
    // A field's use and its retained authoring text are separate. The Host
    // atomically persists this choice with the effective ROM projection.
    const agent = textIntent.current.data as AgentProfileData;
    const next = {
      ...agent,
      customStyle: agent.customStyle ?? (checked ? "" : null),
      customStyleEnabled: checked,
    };
    change(
      next,
      checked && hasConfiguration(next)
        ? canActivate()
        : textIntent.current.enabled,
      0,
      checked && textIntent.current.enabled,
    );
    if (checked)
      requestAnimationFrame(() =>
        document.getElementById(`${id}-customStyle`)?.focus(),
      );
  };
  const openText = (field: "name" | "preferredAddress") => {
    // Opening a personal detail is presentation only: a fallback name must
    // never turn into a configured field or an instruction to the model.
    activeTextEdit.current.add(field);
    const epoch = ++editEpoch.current;
    if (field === "name") setEditingName(true);
    else setEditingAddress(true);
    requestAnimationFrame(() => {
      if (editEpoch.current === epoch && activeTextEdit.current.has(field))
        document.getElementById(`${id}-${field}`)?.focus();
    });
  };
  const clearCompositionValue = (field: "name" | "preferredAddress") => {
    setCompositionValues((current) => {
      if (!(field in current)) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  };
  const finishText = (
    field: "name" | "preferredAddress",
    value: string,
    { unsetBlank = false, restoreFocus = true } = {},
  ) => {
    // Closing a focused editor can itself dispatch blur and an IME's final
    // change. Mark it closed synchronously, before React hides the input.
    if (!activeTextEdit.current.delete(field)) return;
    const epoch = ++editEpoch.current;
    composingText.current.delete(field);
    blurredComposition.current.delete(field);
    clearCompositionValue(field);
    if (unsetBlank && !value.trim()) {
      activateText.delete(field);
      change((current) => ({ ...current, [field]: null }));
    }
    flushText();
    if (field === "name") setEditingName(false);
    else setEditingAddress(false);
    // Pointer/Tab departure belongs to the next control, not this editor.
    if (restoreFocus) {
      const trigger = document.getElementById(`${id}-${field}-edit`);
      const input = document.getElementById(`${id}-${field}`);
      requestAnimationFrame(() => {
        if (
          editEpoch.current === epoch &&
          trigger?.isConnected &&
          [document.body, input, trigger].includes(
            document.activeElement as HTMLElement,
          )
        )
          trigger.focus();
      });
    }
  };
  const blurText = (field: "name" | "preferredAddress", value: string) => {
    if (!activeTextEdit.current.has(field)) return;
    if (composingText.current.has(field)) {
      blurredComposition.current.add(field);
      return;
    }
    finishText(field, value, { unsetBlank: true, restoreFocus: false });
  };
  const endComposition = (
    field: "name" | "preferredAddress",
    value: string,
  ) => {
    if (!activeTextEdit.current.has(field)) return;
    composingText.current.delete(field);
    clearCompositionValue(field);
    // The final composition text must reach the existing queue before an
    // earlier focus departure flushes it. Never clear a provisional IME value.
    textChange(field, value);
    if (blurredComposition.current.delete(field))
      finishText(field, value, { unsetBlank: true, restoreFocus: false });
  };
  const textKey = (
    e: KeyboardEvent<HTMLInputElement>,
    field: "name" | "preferredAddress",
  ) => {
    if (!activeTextEdit.current.has(field)) return;
    if (e.key === "Escape") {
      // A native dialog's cancel is a default action, not event bubbling.
      // Composition may consume Escape without dismissing personal details.
      e.preventDefault();
      e.stopPropagation();
    }
    if (
      (e.key === "Enter" || e.key === "Escape") &&
      !e.nativeEvent.isComposing &&
      !composingText.current.has(field)
    ) {
      e.preventDefault();
      // Escape ends editing; it does not pretend to undo a durable autosave.
      // Drafts and unknown/error receipts remain owned by the scoped queue.
      finishText(field, e.currentTarget.value, {
        unsetBlank: e.key === "Enter",
      });
    }
  };
  async function upload(file?: File) {
    clearPending.current = undefined;
    if (file)
      avatarPending.current = {
        file,
        commandId: crypto.randomUUID(),
        expectedRevision: avatar?.revision ?? 0,
      };
    const request = avatarPending.current;
    if (!request) return;
    setBusy(true);
    setError("");
    try {
      if (request.file.size > avatarMaximumBytes)
        throw new Error("头像不能超过 4 MB。");
      await profile.setAvatar(
        subject,
        request.file,
        request.commandId,
        request.expectedRevision,
      );
      avatarPending.current = undefined;
    } catch (e) {
      if (
        e instanceof RequestError &&
        e.status === 409 &&
        e.code === "conflict"
      )
        setConflict("avatar");
      setError(e instanceof Error ? e.message : "上传失败，请重试。");
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }
  async function clearAvatar() {
    if (!avatar) return;
    clearPending.current ??= {
      commandId: crypto.randomUUID(),
      expectedRevision: avatar.revision,
    };
    setBusy(true);
    setError("");
    try {
      await profile.clearAvatar(
        subject,
        clearPending.current.commandId,
        clearPending.current.expectedRevision,
      );
      clearPending.current = undefined;
    } catch (e) {
      if (
        e instanceof RequestError &&
        e.status === 409 &&
        e.code === "conflict"
      )
        setConflict("avatar");
      setError(e instanceof Error ? e.message : "移除失败，请重试。");
    } finally {
      setBusy(false);
    }
  }
  async function resolveConflict(keepChanges: boolean) {
    if (!avatarConflict) {
      await profile
        .resolveConflict(subject, keepChanges ? "overwrite" : "reload")
        .catch(() => {});
      return;
    }
    setBusy(true);
    try {
      const latest = await profile.refresh();
      if (!latest) throw new Error("资料暂时无法读取，请重试。");
      {
        const fresh = latest[subject].avatar;
        if (keepChanges && avatarPending.current)
          avatarPending.current = {
            ...avatarPending.current,
            commandId: crypto.randomUUID(),
            expectedRevision: fresh.revision,
          };
        else avatarPending.current = undefined;
        if (keepChanges && clearPending.current && fresh.media)
          clearPending.current = {
            commandId: crypto.randomUUID(),
            expectedRevision: fresh.revision,
          };
        else clearPending.current = undefined;
        // Adopting the latest baseline is an explicit choice, not a write.
        // The retained upload/removal still requires its own retry click.
        setError(
          avatarPending.current || clearPending.current
            ? "已读取最新头像，请确认后重试。"
            : "",
        );
      }
      setConflict(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : "读取失败，请重试。");
    } finally {
      setBusy(false);
    }
  }
  const agent = subject === "agent" ? (data as AgentProfileData) : undefined;
  const human = subject === "human" ? (data as HumanProfileData) : undefined;
  const displayName =
    actual?.data.name || (subject === "agent" ? "Morphz" : "我");
  const confirmedAgent =
    subject === "agent"
      ? (actual?.data as AgentProfileData | undefined)
      : undefined;
  const expression =
    confirmedAgent && actual?.enabled
      ? [
          ...traits.flatMap((trait) => {
            const level = confirmedAgent.traits[trait.key];
            return level === null ? [] : [trait.values[level]];
          }),
          ...styles
            .filter((style) => style.value === confirmedAgent.speechStyle)
            .map((style) => style.label),
          ...(profileCustomStyleEnabled(confirmedAgent) &&
          confirmedAgent.customStyle
            ? [confirmedAgent.customStyle]
            : []),
        ]
      : [];
  const expressionText = expression.join(" · ");
  const confirmedAddress =
    subject === "human"
      ? (actual?.data as HumanProfileData | undefined)?.preferredAddress
      : null;
  const usageLabel = subject === "agent" ? "使用人格设定" : "使用个人资料";
  const usageToggle = (
    <label
      className="personality-master"
      title={
        subject === "agent"
          ? "使用人格设定；关闭后不提供自定义名字和表达偏好，选值保留"
          : "使用个人资料；关闭后不提供名字和称呼，选值保留"
      }
    >
      <span className="profile-visually-hidden">{usageLabel}</span>
      <input
        type="checkbox"
        aria-label={usageLabel}
        checked={subject === "agent" ? enabled : configured && enabled}
        disabled={!editable || (subject === "human" && !configured)}
        onChange={(e) => {
          activateText.clear();
          change((current) => current, e.target.checked);
        }}
      />
    </label>
  );
  if (profile.accessDenied)
    return (
      <section
        className="personality-profile"
        aria-label={subject === "agent" ? "智能体资料" : "个人资料"}
      >
        {human && (
          <div className="personality-heading">
            <Heading>{headingText}</Heading>
          </div>
        )}
        <div className="personality-read-error" role="status">
          {profile.error || "当前资料访问已被撤回。"}
          <button
            disabled={profile.loading}
            onClick={() => void profile.refresh().catch(() => {})}
          >
            重试
          </button>
        </div>
      </section>
    );
  return (
    <section
      className="personality-profile"
      aria-label={subject === "agent" ? "智能体资料" : "个人资料"}
      aria-busy={busy}
      data-profile-use={subject === "agent" ? enabled : configured && enabled}
    >
      {human && (
        <div className="personality-heading">
          <Heading>{headingText}</Heading>
          {usageToggle}
        </div>
      )}
      <div className="personality-identity">
        <div className="personality-portrait">
          {subject === "agent" ? (
            <ProfileAvatar
              name={displayName}
              label={stateLabel}
              state={state}
              src={urls?.original}
              posterSrc={urls?.poster}
              animated={animated}
              allowMotion={allowMotion}
              size={64}
            />
          ) : (
            <HumanAvatar
              name={displayName}
              src={urls?.original}
              posterSrc={urls?.poster}
              animated={animated}
              allowMotion={allowMotion}
              size={64}
            />
          )}
          <button
            className="personality-camera"
            type="button"
            aria-label={
              subject === "agent" ? "上传智能体头像" : "上传自己的头像"
            }
            title="PNG、JPEG、GIF 或 WebP，最多 4 MB"
            disabled={
              !editable || busy || !profile.snapshot?.avatarUploadAvailable
            }
            onClick={() => fileInput.current?.click()}
          >
            <Camera size={16} />
          </button>
          <input
            hidden
            type="file"
            ref={fileInput}
            accept="image/png,image/jpeg,image/gif,image/webp"
            onChange={(e) => void upload(e.currentTarget.files?.[0])}
          />
        </div>
        <div className="personality-name">
          <button
            id={`${id}-name-edit`}
            className="personality-name-display"
            type="button"
            aria-label={subject === "agent" ? "编辑智能体名字" : "编辑你的名字"}
            title={displayName}
            hidden={editingName}
            disabled={!editable}
            onClick={() => openText("name")}
          >
            <span>{displayName}</span>
          </button>
          <div className="personality-inline-editor" hidden={!editingName}>
            <input
              id={`${id}-name`}
              aria-label={subject === "agent" ? "智能体的名字" : "你的名字"}
              data-configured={data.name !== null}
              maxLength={40}
              value={compositionValues.name ?? data.name ?? ""}
              disabled={!editable}
              placeholder={subject === "agent" ? "Morphz" : "你的名字"}
              onChange={(e) => textChange("name", e.target.value)}
              onBlur={(e) => blurText("name", e.currentTarget.value)}
              onCompositionStart={() => composingText.current.add("name")}
              onCompositionEnd={(e) =>
                endComposition("name", e.currentTarget.value)
              }
              onKeyDown={(e) => textKey(e, "name")}
            />
          </div>
          {avatar?.media && (
            <button
              className="personality-text-action"
              disabled={!editable || busy}
              onClick={() => void clearAvatar()}
            >
              移除头像
            </button>
          )}
        </div>
        {agent && usageToggle}
      </div>
      {human && (
        <div className="personality-field">
          <button
            id={`${id}-preferredAddress-edit`}
            className="personality-detail-display"
            type="button"
            aria-label="编辑称呼"
            hidden={editingAddress}
            disabled={!editable}
            onClick={() => openText("preferredAddress")}
          >
            <span>称呼</span>
            <span>{confirmedAddress || "未设置"}</span>
          </button>
          <div
            className="personality-inline-editor personality-address-editor"
            hidden={!editingAddress}
          >
            <label htmlFor={`${id}-preferredAddress`}>称呼</label>
            <input
              id={`${id}-preferredAddress`}
              aria-label="Agent 对你的称呼"
              data-configured={human.preferredAddress !== null}
              maxLength={40}
              value={
                compositionValues.preferredAddress ??
                human.preferredAddress ??
                ""
              }
              placeholder="希望我怎么称呼你"
              disabled={!editable}
              onChange={(e) => textChange("preferredAddress", e.target.value)}
              onBlur={(e) =>
                blurText("preferredAddress", e.currentTarget.value)
              }
              onCompositionStart={() =>
                composingText.current.add("preferredAddress")
              }
              onCompositionEnd={(e) =>
                endComposition("preferredAddress", e.currentTarget.value)
              }
              onKeyDown={(e) => textKey(e, "preferredAddress")}
            />
          </div>
        </div>
      )}
      {agent && (
        <PersistentDetails
          className="personality-preferences"
          storageScope={profile.interfaceScope}
          preferenceKey="profile:agent:expression"
        >
          <summary data-has-expression={!!expressionText}>
            <span>个性与表达</span>
            {expressionText && (
              <span className="personality-expression" title={expressionText}>
                {expressionText}
              </span>
            )}
            <ChevronRight size={14} aria-hidden="true" />
          </summary>
          <div className="personality-preferences-editor">
            <div className="personality-traits">
              {traits.map((trait) => {
                const level = agent.traits[trait.key];
                return (
                  <div
                    className="personality-trait"
                    data-configured={level !== null}
                    key={trait.key}
                  >
                    <span className="personality-trait-heading">
                      <span>{trait.label}</span>
                      {level !== null && (
                        <span className="personality-trait-value">
                          <output htmlFor={`${id}-${trait.key}`}>
                            <span>{trait.values[level]}</span>
                            <b>{level}</b>
                          </output>
                        </span>
                      )}
                      <label className="personality-optional">
                        <span className="profile-visually-hidden">
                          {level === null ? "不设置" : "已设置"}
                        </span>
                        <input
                          type="checkbox"
                          aria-label={`设置${trait.label}`}
                          checked={level !== null}
                          disabled={!editable}
                          onChange={(e) =>
                            change(
                              (current) => ({
                                ...current,
                                traits: {
                                  ...(current as AgentProfileData).traits,
                                  [trait.key]: e.target.checked ? 0 : null,
                                },
                              }),
                              e.target.checked
                                ? canActivate()
                                : textIntent.current.enabled,
                            )
                          }
                        />
                      </label>
                    </span>
                    {level !== null && (
                      <>
                        <input
                          type="range"
                          id={`${id}-${trait.key}`}
                          aria-label={`${trait.label}程度`}
                          aria-valuetext={`${level}，${trait.values[level]}`}
                          min={0}
                          max={5}
                          step={1}
                          value={level}
                          disabled={!editable}
                          style={
                            {
                              "--trait-fill": `${level * 20}%`,
                            } as CSSProperties
                          }
                          onChange={(e) =>
                            change(
                              (current) => ({
                                ...current,
                                traits: {
                                  ...(current as AgentProfileData).traits,
                                  [trait.key]: Number(e.target.value),
                                },
                              }),
                              textIntent.current.enabled,
                              300,
                            )
                          }
                          onPointerUp={flushText}
                          onBlur={flushText}
                        />
                        <span className="personality-trait-ends">
                          <span>{trait.low}</span>
                          <span>{trait.high}</span>
                        </span>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
            <fieldset className="personality-speaking" disabled={!editable}>
              <legend>讲话风格</legend>
              <div>
                <label>
                  <input
                    type="radio"
                    name={`${id}-style`}
                    checked={agent.speechStyle === null}
                    onChange={() =>
                      change((current) => ({ ...current, speechStyle: null }))
                    }
                  />
                  <span>不设置</span>
                </label>
                {styles.map((style) => (
                  <label key={style.value}>
                    <input
                      type="radio"
                      name={`${id}-style`}
                      value={style.value}
                      checked={agent.speechStyle === style.value}
                      onChange={() =>
                        change(
                          (current) => ({
                            ...current,
                            speechStyle: style.value,
                          }),
                          (textIntent.current.data as AgentProfileData)
                            .speechStyle === null
                            ? canActivate()
                            : textIntent.current.enabled,
                        )
                      }
                    />
                    <span>{style.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div
              className="personality-custom"
              data-expanded={profileCustomStyleEnabled(agent)}
            >
              <label
                className="personality-optional"
                htmlFor={`${id}-customStyle-use`}
              >
                <span>自定义风格</span>
                <input
                  id={`${id}-customStyle-use`}
                  type="checkbox"
                  aria-label="设置自定义风格"
                  aria-controls={`${id}-customStyle`}
                  checked={profileCustomStyleEnabled(agent)}
                  disabled={!editable}
                  onChange={(e) => selectCustomStyle(e.target.checked)}
                />
              </label>
              <textarea
                id={`${id}-customStyle`}
                aria-label="自定义讲话风格"
                data-configured={agent.customStyle !== null}
                maxLength={500}
                rows={3}
                hidden={!profileCustomStyleEnabled(agent)}
                disabled={!editable || !profileCustomStyleEnabled(agent)}
                value={agent.customStyle ?? ""}
                placeholder="例如：先给结论，再聊细节。"
                onChange={(e) => textChange("customStyle", e.target.value)}
                onBlur={flushText}
              />
            </div>
          </div>
        </PersistentDetails>
      )}
      {!actual?.editable && actual?.available && (
        <p className="muted">由中心管理员管理</p>
      )}
      {(!actual?.available || profile.error || profile.media.error) && (
        <div className="personality-read-error" role="status">
          {profile.loading
            ? "读取资料…"
            : profile.error || profile.media.error || "智能体连接后可编辑"}
          <button
            disabled={busy || profile.loading}
            onClick={() => void profile.refresh().catch(() => {})}
          >
            重试
          </button>
        </div>
      )}
      <span
        className="personality-save-state profile-visually-hidden"
        role="status"
        aria-live="polite"
      >
        {busy
          ? "正在保存资料"
          : auto.dirty
            ? "资料修改尚未确认"
            : actual?.revision
              ? "资料已保存"
              : ""}
      </span>
      {error && (
        <div className="personality-error" role="alert">
          {error}
          {conflict && (
            <span className="personality-conflict-actions">
              <button
                disabled={busy}
                onClick={() => void resolveConflict(false)}
              >
                使用最新
              </button>
              <button
                disabled={busy}
                onClick={() => void resolveConflict(true)}
              >
                保留修改
              </button>
            </span>
          )}
          {!conflict && avatarPending.current && (
            <button disabled={busy} onClick={() => void upload()}>
              重试上传
            </button>
          )}
          {!conflict && clearPending.current && (
            <button disabled={busy} onClick={() => void clearAvatar()}>
              重试移除
            </button>
          )}
          {!conflict && auto.error && (
            <button
              disabled={busy}
              onClick={() => void profile.retry(subject).catch(() => {})}
            >
              重试保存
            </button>
          )}
        </div>
      )}
    </section>
  );
}
