import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { Camera, ChevronRight, Pencil } from "lucide-react";
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
  const [avatarBusy, setBusy] = useState(false);
  const [avatarError, setError] = useState("");
  const [avatarConflict, setConflict] = useState<"avatar">();
  const [editingName, setEditingName] = useState(false);
  const [editingAddress, setEditingAddress] = useState(false);
  const busy = avatarBusy || auto.saving;
  const conflict = avatarConflict || auto.conflict;
  const error = avatarError || auto.error;
  const activateText = profile.textActivation[subject];
  // Like the save queue, an intermediate empty name retains the last
  // confirmed name; only the explicit unset action clears it.
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
  const canActivate = enabled || !configured;
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
    next: AgentProfileData | HumanProfileData,
    nextEnabled = enabled,
    delay = 0,
    allowEmpty = false,
  ) => {
    setError("");
    const configured = hasConfiguration(next);
    profile.edit(
      subject,
      next,
      configured || allowEmpty ? nextEnabled : false,
      delay,
    );
  };
  const textChange = (
    field: "name" | "preferredAddress" | "customStyle",
    value: string,
  ) => {
    const firstValue =
      !!value.trim() && canActivate && (activateText.has(field) || !configured);
    if (value.trim()) activateText.delete(field);
    change({ ...data, [field]: value }, firstValue ? true : enabled, 450, true);
  };
  const flushText = () => void profile.flush(subject).catch(() => {});
  const selectText = (field: "name" | "preferredAddress", checked: boolean) => {
    if (checked && canActivate) activateText.add(field);
    else activateText.delete(field);
    change(
      { ...data, [field]: checked ? "" : null },
      enabled,
      0,
      checked && enabled,
    );
    if (checked)
      requestAnimationFrame(() => {
        document.getElementById(`${id}-${field}`)?.focus();
      });
  };
  const selectCustomStyle = (checked: boolean) => {
    if (checked && canActivate) activateText.add("customStyle");
    else activateText.delete("customStyle");
    // A field's use and its retained authoring text are separate. The Host
    // atomically persists this choice with the effective ROM projection.
    const agent = data as AgentProfileData;
    change(
      {
        ...agent,
        customStyle: agent.customStyle ?? (checked ? "" : null),
        customStyleEnabled: checked,
      },
      checked ? canActivate : enabled,
      0,
      checked && enabled,
    );
    if (checked)
      requestAnimationFrame(() =>
        document.getElementById(`${id}-customStyle`)?.focus(),
      );
  };
  const openText = (field: "name" | "preferredAddress") => {
    // Opening a personal detail is presentation only: a fallback name must
    // never turn into a configured field or an instruction to the model.
    if (field === "name") setEditingName(true);
    else setEditingAddress(true);
    requestAnimationFrame(() =>
      document.getElementById(`${id}-${field}`)?.focus(),
    );
  };
  const finishText = (field: "name" | "preferredAddress") => {
    flushText();
    if (field === "name") setEditingName(false);
    else setEditingAddress(false);
    requestAnimationFrame(() =>
      document.getElementById(`${id}-${field}-edit`)?.focus(),
    );
  };
  const textKey = (
    e: KeyboardEvent<HTMLInputElement>,
    field: "name" | "preferredAddress",
  ) => {
    if (e.key === "Escape") {
      // A native dialog's cancel is a default action, not event bubbling.
      // Composition may consume Escape without dismissing personal details.
      e.preventDefault();
      e.stopPropagation();
    }
    if (
      (e.key === "Enter" || e.key === "Escape") &&
      !e.nativeEvent.isComposing
    ) {
      e.preventDefault();
      // Escape ends editing; it does not pretend to undo a durable autosave.
      // Drafts and unknown/error receipts remain owned by the scoped queue.
      finishText(field);
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
  const usageToggle = (
    <label
      className="personality-master"
      title={
        subject === "agent"
          ? "使用人格设定；关闭后不加入自定义名字和表达偏好，选值保留"
          : "使用个人资料；关闭后不提供名字和称呼，选值保留"
      }
    >
      <span className="profile-visually-hidden">
        {subject === "agent" ? "使用人格设定" : "使用个人资料"}
      </span>
      <input
        type="checkbox"
        aria-label={subject === "agent" ? "使用人格设定" : "使用个人资料"}
        checked={configured && enabled}
        disabled={!editable || !configured}
        onChange={(e) => {
          activateText.clear();
          change(data, e.target.checked);
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
            <Pencil size={13} aria-hidden="true" />
          </button>
          <div className="personality-inline-editor" hidden={!editingName}>
            <input
              id={`${id}-name`}
              aria-label={subject === "agent" ? "智能体的名字" : "你的名字"}
              data-configured={data.name !== null}
              maxLength={40}
              value={data.name ?? ""}
              disabled={!editable}
              placeholder={subject === "agent" ? "Morphz" : "你的名字"}
              onChange={(e) => textChange("name", e.target.value)}
              onBlur={flushText}
              onKeyDown={(e) => textKey(e, "name")}
            />
            <div className="personality-edit-actions">
              <button
                type="button"
                disabled={!editable}
                onClick={() => finishText("name")}
              >
                完成
              </button>
              <button
                type="button"
                aria-label={
                  subject === "agent" ? "不设置智能体名字" : "不设置你的名字"
                }
                disabled={!editable}
                onClick={() => {
                  selectText("name", false);
                  finishText("name");
                }}
              >
                不设置
              </button>
            </div>
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
            <Pencil size={13} aria-hidden="true" />
          </button>
          <div className="personality-inline-editor" hidden={!editingAddress}>
            <label
              className="profile-visually-hidden"
              htmlFor={`${id}-preferredAddress`}
            >
              称呼
            </label>
            <input
              id={`${id}-preferredAddress`}
              aria-label="Agent 对你的称呼"
              data-configured={human.preferredAddress !== null}
              maxLength={40}
              value={human.preferredAddress ?? ""}
              placeholder="希望我怎么称呼你"
              disabled={!editable}
              onChange={(e) => textChange("preferredAddress", e.target.value)}
              onBlur={flushText}
              onKeyDown={(e) => textKey(e, "preferredAddress")}
            />
            <div className="personality-edit-actions">
              <button
                type="button"
                disabled={!editable}
                onClick={() => finishText("preferredAddress")}
              >
                完成
              </button>
              <button
                type="button"
                aria-label="不设置称呼"
                disabled={!editable}
                onClick={() => {
                  selectText("preferredAddress", false);
                  finishText("preferredAddress");
                }}
              >
                不设置
              </button>
            </div>
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
                              {
                                ...agent,
                                traits: {
                                  ...agent.traits,
                                  [trait.key]: e.target.checked ? 0 : null,
                                },
                              },
                              e.target.checked ? canActivate : enabled,
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
                              {
                                ...agent,
                                traits: {
                                  ...agent.traits,
                                  [trait.key]: Number(e.target.value),
                                },
                              },
                              enabled,
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
                    onChange={() => change({ ...agent, speechStyle: null })}
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
                          { ...agent, speechStyle: style.value },
                          agent.speechStyle === null ? canActivate : enabled,
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
