import type { LiveMessage } from "../../../packages/core/src/live-conversation.js";

export function RuntimeMessageError({
  message,
}: {
  message: LiveMessage & { errorDetails?: string };
}) {
  return (
    <div className="runtime-message-error" data-quote-ignore>
      <p data-quote-ignore>
        {message.failure?.state === "response_annotations"
          ? "回复格式解析失败，未能显示本次回答。"
          : "这次回复未能完成。"}
      </p>
      <details>
        <summary data-quote-ignore>错误详情</summary>
        <pre>{message.errorDetails ?? message.text}</pre>
      </details>
    </div>
  );
}
