import { useId, useRef } from "react";
import { Check, X } from "lucide-react";
import {
  sameCognitiveAppApplicationTarget,
  type CognitiveAppApplicationTarget,
} from "../../../../../packages/core/src/cognitive-app-application-target.js";
import {
  cognitiveApplicationTargets,
  cognitiveAvailabilityReason,
  type CognitiveApplicationEntry,
} from "../../application-presentation.js";
import { ApplicationImage } from "../../ApplicationIcon.js";
import { useModal } from "../../useModal.js";
import "./CognitiveApplicationChoices.css";

/** The same explicit option content is used by Workbench, Launcher/Dock and
 * input association. It selects no first/default connection and performs no IO. */
export function CognitiveApplicationChoices({
  entries,
  current,
  disabledReason,
  onChoose,
}: {
  entries: readonly CognitiveApplicationEntry[];
  current?: CognitiveAppApplicationTarget;
  disabledReason?: string;
  onChoose(target: CognitiveAppApplicationTarget): void;
}) {
  return (
    <div className="cognitive-application-choices">
      <p className="cognitive-application-choices-help">
        选择应用和数据连接，仅用于本次输入；不会打开界面或开始工作。
      </p>
      {disabledReason && <p role="status">{disabledReason}</p>}
      {entries.length === 0 && (
        <p role="status">当前没有可选择的应用，原草稿和应用目标仍保留。</p>
      )}
      {entries.map((entry) => {
        const targets = cognitiveApplicationTargets(entry);
        const reason = disabledReason || cognitiveAvailabilityReason(entry);
        return (
          <section
            key={entry.key}
            aria-label={`${entry.metadata.title} ${entry.metadata.version}`}
          >
            <header>
              <span className="cognitive-application-choices-image">
                <ApplicationImage app={entry.metadata} />
              </span>
              <div>
                <h3>
                  {entry.metadata.title} <small>{entry.metadata.version}</small>
                </h3>
                <p>
                  {entry.gui === "absent"
                    ? "此应用没有独立界面。"
                    : "应用界面尚未开放，仍可用于本次输入。"}
                </p>
              </div>
            </header>
            {reason && (
              <p className="cognitive-application-choices-unavailable">
                {reason}
              </p>
            )}
            <ul>
              {entry.connections.map((connection) => {
                const target = targets.find(
                  (candidate) =>
                    candidate.connectionId === connection.connectionId,
                );
                const selected =
                  !!target &&
                  sameCognitiveAppApplicationTarget(current, target);
                return (
                  <li key={connection.connectionId}>
                    <button
                      type="button"
                      aria-label={`使用${entry.metadata.title} ${entry.metadata.version}，数据连接 ${connection.connectionId}`}
                      aria-pressed={selected}
                      disabled={!!reason || !target}
                      title={
                        reason ||
                        (connection.state === "active"
                          ? "仅指定下一次输入，不发送或开始执行"
                          : "此数据连接已停用或不可用")
                      }
                      onClick={() => {
                        if (target && !reason) onChoose(target);
                      }}
                    >
                      <span>
                        <strong>{connection.dataAuthorityId}</strong>
                        <small>{connection.serviceId}</small>
                        <small>
                          数据连接 {connection.connectionId}
                          {connection.state === "active"
                            ? " · 已启用"
                            : connection.state === "disabled"
                              ? " · 已停用"
                              : " · 不可用"}
                        </small>
                      </span>
                      {selected && <Check aria-hidden="true" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** The actual App owns the captured identity/context and latest draft writer.
 * This temporary shared modal is presentation only, not a second selection store. */
export function CognitiveApplicationPicker({
  entries,
  current,
  disabledReason,
  onChoose,
  onClose,
}: {
  entries: readonly CognitiveApplicationEntry[];
  current?: CognitiveAppApplicationTarget;
  disabledReason?: string;
  onChoose(target: CognitiveAppApplicationTarget): void;
  onClose(): void;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useModal(dialog, heading);
  return (
    <dialog
      ref={dialog}
      className="create-dialog cognitive-application-picker"
      aria-labelledby={id}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header>
        <h2 id={id} ref={heading} tabIndex={-1}>
          本次输入使用的应用
        </h2>
        <button
          type="button"
          className="icon-button"
          aria-label="关闭应用选择"
          onClick={onClose}
        >
          <X />
        </button>
      </header>
      <div className="cognitive-application-picker-body">
        <CognitiveApplicationChoices
          entries={entries}
          current={current}
          disabledReason={disabledReason}
          onChoose={onChoose}
        />
      </div>
    </dialog>
  );
}
