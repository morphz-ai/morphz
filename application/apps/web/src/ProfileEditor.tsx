import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { Camera, Check, RotateCcw } from "lucide-react";
import {
  defaultAgentProfile,
  defaultHumanProfile,
  profileUpdateSchema,
  avatarMaximumBytes,
  type AgentProfileData,
  type HumanProfileData,
  type ProfileSubject,
  type ProfileUpdate,
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
  const savedDraft = profile.drafts.current[subject];
  const [data, setData] = useState<AgentProfileData | HumanProfileData>(
    savedDraft?.data ??
      actual?.data ??
      (subject === "agent" ? defaultAgentProfile : defaultHumanProfile),
  );
  const [revision, setRevision] = useState(
    savedDraft?.revision ?? actual?.revision ?? 0,
  );
  const [dirty, setDirty] = useState(!!savedDraft);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  const [conflict, setConflict] = useState<"profile" | "avatar">();
  const pending = useRef<
    { fingerprint: string; command: ProfileUpdate } | undefined
  >(savedDraft?.pending);
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
  const editable = !!actual?.available && actual.editable && !busy && !conflict;
  const urls = profile.media[subject];
  const avatar = actual?.avatar;
  const animated = (avatar?.media?.frames ?? 1) > 1;
  useEffect(() => {
    if (actual && !dirty) {
      setData(actual.data);
      setRevision(actual.revision);
    }
  }, [actual?.revision, actual?.available, dirty]);
  useEffect(() => {
    onBusy?.(busy);
    return () => onBusy?.(false);
  }, [busy, onBusy]);
  const change = (next: AgentProfileData | HumanProfileData) => {
    setData(next);
    setDirty(true);
    setSaved(false);
    setError("");
    if (subject === "agent")
      profile.drafts.current.agent = {
        data: next as AgentProfileData,
        revision,
      };
    else
      profile.drafts.current.human = {
        data: next as HumanProfileData,
        revision,
      };
  };
  async function save() {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const candidate = profileUpdateSchema.parse({
        subject,
        commandId: "pending",
        expectedRevision: revision,
        data,
      });
      const fingerprint = JSON.stringify(candidate);
      if (pending.current?.fingerprint !== fingerprint)
        pending.current = {
          fingerprint,
          command: { ...candidate, commandId: crypto.randomUUID() },
        };
      // Closing a failed form must not invent a new command for an ambiguous
      // write. This is a scoped in-memory intent, never another profile store.
      if (candidate.subject === "agent")
        profile.drafts.current.agent = {
          data: candidate.data,
          revision: candidate.expectedRevision,
          pending: pending.current,
        };
      else
        profile.drafts.current.human = {
          data: candidate.data,
          revision: candidate.expectedRevision,
          pending: pending.current,
        };
      const result = await profile.save(pending.current.command);
      setData(result[subject].data);
      setRevision(result[subject].revision);
      delete profile.drafts.current[subject];
      pending.current = undefined;
      setDirty(false);
      setSaved(true);
    } catch (e) {
      if (
        e instanceof RequestError &&
        e.status === 409 &&
        e.code === "conflict"
      )
        setConflict("profile");
      setError(e instanceof Error ? e.message : "保存失败，请重试。");
    } finally {
      setBusy(false);
    }
  }
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
    setBusy(true);
    setSaved(false);
    try {
      const latest = await profile.refresh();
      if (!latest) throw new Error("资料暂时无法读取，请重试。");
      if (conflict === "profile") {
        const fresh = latest[subject];
        pending.current = undefined;
        setRevision(fresh.revision);
        if (keepChanges) {
          if (subject === "agent")
            profile.drafts.current.agent = {
              data: data as AgentProfileData,
              revision: fresh.revision,
            };
          else
            profile.drafts.current.human = {
              data: data as HumanProfileData,
              revision: fresh.revision,
            };
          setDirty(true);
        } else {
          setData(fresh.data);
          delete profile.drafts.current[subject];
          setDirty(false);
        }
        setError("");
      } else {
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
      <div className="personality-identity">
        <div className="personality-portrait">
          {subject === "agent" ? (
            <ProfileAvatar
              name={data.name}
              label={stateLabel}
              state={state}
              src={urls?.original}
              posterSrc={urls?.poster}
              animated={animated}
              allowMotion={allowMotion}
              size={96}
            />
          ) : (
            <HumanAvatar
              name={data.name}
              src={urls?.original}
              posterSrc={urls?.poster}
              animated={animated}
              allowMotion={allowMotion}
              size={96}
            />
          )}
          <button
            className="personality-camera"
            type="button"
            aria-label={
              subject === "agent" ? "上传智能体头像" : "上传自己的头像"
            }
            title="PNG、JPEG、GIF 或 WebP，最多 4 MB"
            disabled={!editable || !profile.snapshot?.avatarUploadAvailable}
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
          <label htmlFor={`${id}-name`}>
            {subject === "agent" ? "名字" : "你的名字"}
          </label>
          <input
            id={`${id}-name`}
            aria-label={subject === "agent" ? "智能体的名字" : "你的名字"}
            maxLength={40}
            value={data.name}
            disabled={!editable}
            placeholder={subject === "agent" ? "你想怎么叫我？" : "你的名字"}
            onChange={(e) => change({ ...data, name: e.target.value })}
          />
          {avatar?.media && (
            <button
              className="personality-text-action"
              disabled={!editable}
              onClick={() => void clearAvatar()}
            >
              移除头像
            </button>
          )}
        </div>
      </div>
      {actual?.available && actual.revision === 0 && subject === "agent" && (
        <div className="personality-onboarding">
          <span>先给我起个名字吧。</span>
          <button
            disabled={!editable}
            onClick={() => {
              change({ ...data, name: "Morphz" });
            }}
          >
            就叫 Morphz
          </button>
        </div>
      )}
      {human && (
        <label className="personality-field">
          希望我怎么称呼你
          <input
            aria-label="Agent 对你的称呼"
            maxLength={40}
            value={human.preferredAddress}
            placeholder="用你的名字"
            disabled={!editable}
            onChange={(e) =>
              change({ ...human, preferredAddress: e.target.value })
            }
          />
        </label>
      )}
      {agent && (
        <>
          <div className="personality-traits">
            {traits.map((trait) => (
              <label className="personality-trait" key={trait.key}>
                <span className="personality-trait-heading">
                  <span>{trait.label}</span>
                  <output htmlFor={`${id}-${trait.key}`}>
                    <span>{trait.values[agent.traits[trait.key]]}</span>
                    <b>{agent.traits[trait.key]}</b>
                  </output>
                </span>
                <input
                  type="range"
                  id={`${id}-${trait.key}`}
                  aria-label={`${trait.label}程度`}
                  aria-valuetext={`${agent.traits[trait.key]}，${trait.values[agent.traits[trait.key]]}`}
                  min={0}
                  max={5}
                  step={1}
                  value={agent.traits[trait.key]}
                  disabled={!editable}
                  style={
                    {
                      "--trait-fill": `${agent.traits[trait.key] * 20}%`,
                    } as CSSProperties
                  }
                  onChange={(e) =>
                    change({
                      ...agent,
                      traits: {
                        ...agent.traits,
                        [trait.key]: Number(e.target.value),
                      },
                    })
                  }
                />
                <span className="personality-trait-ends">
                  <span>{trait.low}</span>
                  <span>{trait.high}</span>
                </span>
              </label>
            ))}
          </div>
          <fieldset className="personality-speaking" disabled={!editable}>
            <legend>讲话风格</legend>
            <div>
              {styles.map((style) => (
                <label key={style.value}>
                  <input
                    type="radio"
                    name={`${id}-style`}
                    value={style.value}
                    checked={agent.speechStyle === style.value}
                    onChange={() =>
                      change({ ...agent, speechStyle: style.value })
                    }
                  />
                  <span>{style.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <details className="personality-custom">
            <summary>自定义风格</summary>
            <textarea
              aria-label="自定义讲话风格"
              maxLength={500}
              rows={3}
              disabled={!editable}
              value={agent.customStyle ?? ""}
              placeholder="例如：先给结论，再聊细节。"
              onChange={(e) =>
                change({ ...agent, customStyle: e.target.value || undefined })
              }
            />
          </details>
        </>
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
      <footer className="personality-actions">
        <span
          className="personality-save-state"
          role="status"
          aria-live="polite"
        >
          {busy ? (
            "保存中…"
          ) : saved ? (
            <>
              <Check size={14} />
              已保存
            </>
          ) : dirty ? (
            "未保存"
          ) : (
            ""
          )}
        </span>
        {dirty && (
          <button
            className="personality-reset"
            aria-label="恢复已保存资料"
            disabled={busy || !!conflict}
            onClick={() => {
              if (!actual) return;
              setData(actual.data);
              setRevision(actual.revision);
              setDirty(false);
              setError("");
              pending.current = undefined;
              delete profile.drafts.current[subject];
            }}
          >
            <RotateCcw size={14} />
          </button>
        )}
        <button
          className="button primary personality-save"
          disabled={
            !editable ||
            !!conflict ||
            !data.name.trim() ||
            (!dirty && actual?.revision !== 0)
          }
          title={
            subject === "agent"
              ? "保存后用于新工作，已开始的工作保持原设定"
              : "只设置你的个人资料"
          }
          onClick={() => void save()}
        >
          保存
        </button>
      </footer>
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
        </div>
      )}
    </section>
  );
}
