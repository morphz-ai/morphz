import type { LiveMessage } from "../../../packages/core/src/live-conversation.js";
import { runtimeErrorDetails } from "./runtime-error-presentation.js";

export function RuntimeMessageError({
  message,
}: {
  message: LiveMessage & { errorDetails?: string };
}) {
  const details = runtimeErrorDetails(message);
  const short = !details.includes("\n") && [...details].length <= 160;
  return (
    <div className="runtime-message-error" data-quote-ignore>
      <p data-quote-ignore>
        {message.failure?.state === "response_annotations"
          ? "回复格式解析失败，未能显示本次回答。"
          : "这次回复未能完成。"}
      </p>
      {details &&
        (short ? (
          <p className="runtime-message-error-reason" data-quote-ignore>
            {details}
          </p>
        ) : (
          <details>
            <summary data-quote-ignore>错误详情</summary>
            <pre data-quote-ignore>{details}</pre>
          </details>
        ))}
    </div>
  );
}
