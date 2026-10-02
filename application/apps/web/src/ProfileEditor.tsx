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
  avatarMaximumBytes,
  profileHasConfiguredFields,
  type AgentProfileData,
  type HumanProfileData,
  type ProfileSubject,
} from "../../../packages/core/src/profile.js";
import { ProfileAvatar, type ProfileAvatarState } from "./ProfileAvatar.js";
import { HumanAvatar } from "./HumanAvatar.js";
import type { ProfileController } from "./useProfile.js";
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
  const busy = avatarBusy || auto.saving;
  const conflict = avatarConflict || auto.conflict;
  const error = avatarError || auto.error;
  const activateText = profile.textActivation[subject];
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
    const configured = profileHasConfiguredFields({
      ...next,
      name: next.name?.trim() || null,
    });
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
    const firstValue = activateText.has(field) && !!value.trim();
    if (firstValue) activateText.delete(field);
    change({ ...data, [field]: value }, firstValue ? true : enabled, 450, true);
  };
  const flushText = () => void profile.flush(subject).catch(() => {});
  const selectText = (
    field: "name" | "preferredAddress" | "customStyle",
    checked: boolean,
  ) => {
    if (checked) activateText.add(field);
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
  const textKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      flushText();
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
  if (profile.accessDenied)
    return (
      <section
        className="personality-profile"
        aria-label={subject === "agent" ? "智能体资料" : "个人资料"}
      >
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
      <label
        className="personality-master"
        title="把名字和表达偏好用于对话；关闭时保留设置"
      >
        <span>使用设定</span>
        <span className="personality-master-state profile-visually-hidden">
          {actual?.enabled ? "已启用" : "未启用"}
        </span>
        <input
          type="checkbox"
          aria-label="使用 Profile"
          checked={enabled}
          disabled={!editable}
          onChange={(e) => {
            activateText.clear();
            change(data, e.target.checked, 0, e.target.checked);
          }}
        />
      </label>
      <div className="personality-identity">
        <div className="personality-portrait">
          {subject === "agent" ? (
            <ProfileAvatar
              name={data.name ?? "Morphz"}
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
              name={data.name ?? "我"}
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
          <label className="personality-optional" htmlFor={`${id}-name-set`}>
            <span>{subject === "agent" ? "名字" : "你的名字"}</span>
            <span className="profile-visually-hidden">
              {data.name === null ? "不设置" : "已设置"}
            </span>
            <input
              id={`${id}-name-set`}
              type="checkbox"
              aria-label={
                subject === "agent" ? "设置智能体名字" : "设置你的名字"
              }
              checked={data.name !== null}
              disabled={!editable}
              onChange={(e) => selectText("name", e.target.checked)}
            />
          </label>
          <input
            id={`${id}-name`}
            aria-label={subject === "agent" ? "智能体的名字" : "你的名字"}
            maxLength={40}
            value={data.name ?? ""}
            disabled={!editable || data.name === null}
            placeholder={subject === "agent" ? "Morphz" : "你的名字"}
            onChange={(e) => textChange("name", e.target.value)}
            onBlur={flushText}
            onKeyDown={textKey}
          />
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
      </div>
      {human && (
        <div className="personality-field">
          <label className="personality-optional">
            <span>希望我怎么称呼你</span>
            <span className="profile-visually-hidden">
              {human.preferredAddress === null ? "不设置" : "已设置"}
            </span>
            <input
              type="checkbox"
              aria-label="设置称呼"
              checked={human.preferredAddress !== null}
              disabled={!editable}
              onChange={(e) => selectText("preferredAddress", e.target.checked)}
            />
          </label>
          <input
            id={`${id}-preferredAddress`}
            aria-label="Agent 对你的称呼"
            maxLength={40}
            value={human.preferredAddress ?? ""}
            placeholder="称呼"
            disabled={!editable || human.preferredAddress === null}
            onChange={(e) => textChange("preferredAddress", e.target.value)}
            onBlur={flushText}
            onKeyDown={textKey}
          />
        </div>
      )}
      {agent && (
        <div className="personality-preferences">
          <h4 className="personality-group-title">表达偏好</h4>
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
                            e.target.checked ? true : enabled,
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
                        agent.speechStyle === null ? true : enabled,
                      )
                    }
                  />
                  <span>{style.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <details className="personality-custom">
            <summary>
              <span>自定义风格</span>
              <ChevronRight size={14} />
            </summary>
            <label className="personality-optional">
              <span className="profile-visually-hidden">
                {agent.customStyle === null ? "不设置" : "已设置"}
              </span>
              <input
                type="checkbox"
                aria-label="设置自定义风格"
                checked={agent.customStyle !== null}
                disabled={!editable}
                onChange={(e) => selectText("customStyle", e.target.checked)}
              />
            </label>
            <textarea
              id={`${id}-customStyle`}
              aria-label="自定义讲话风格"
              maxLength={500}
              rows={3}
              disabled={!editable || agent.customStyle === null}
              value={agent.customStyle ?? ""}
              placeholder="例如：先给结论，再聊细节。"
              onChange={(e) => textChange("customStyle", e.target.value)}
              onBlur={flushText}
            />
          </details>
        </div>
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
