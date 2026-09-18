import { useEffect, useState } from "react";
import type { WorkspaceClient } from "./client.js";

/** Service identity is diagnostic/disclosure information, not the feature name. */
export function SpeechServiceDetails({
  client,
  mode,
}: {
  client: WorkspaceClient;
  mode: "read" | "dictate";
}) {
  const [status, setStatus] = useState<Awaited<
    ReturnType<WorkspaceClient["speechStatus"]>
  > | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void client
      .speechStatus(controller.signal)
      .then(setStatus)
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [client.speechStatus]);
  return (
    <details className="speech-service-details">
      <summary>语音服务与隐私</summary>
      <p>
        {status
          ? status.configured
            ? `当前服务：${status.providerLabel || (status.provider === "doubao" ? "豆包" : status.provider) || "已配置的语音服务"}。`
            : "尚未配置语音服务。"
          : failed
            ? "暂时无法读取服务信息。"
            : "正在读取服务信息…"}
        {mode === "read"
          ? "朗读文字发送至该服务，可能消耗服务额度。"
          : "录音分段发送至该服务，可能消耗服务额度。"}
      </p>
    </details>
  );
}
