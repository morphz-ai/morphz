import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Mic, Square } from "lucide-react";
import { ComposerActionBar } from "../../apps/web/src/ComposerActionBar.js";

// Actual main.tsx CSS imports are inserted here by the isolated test server.
// No App, Client, microphone, provider, Runtime, profile or input submission.
type Scenario = {
  accent: "cyan" | "iris" | "coral" | "mono";
  appearance: "light" | "dark";
  recording: boolean;
  sending: boolean;
};
let patch: (next: Partial<Scenario>) => void;
let remembered: Element | null = null;

function Fixture() {
  const [scenario, setScenario] = useState<Scenario>({
    accent: "cyan",
    appearance: "light",
    recording: false,
    sending: false,
  });
  patch = (next) =>
    flushSync(() => setScenario((previous) => ({ ...previous, ...next })));
  const speechRecording = scenario.recording,
    sending = scenario.sending,
    draft = { pendingSupplement: undefined },
    client = { online: true },
    inputTools = {
      toggleDictation: () => patch({ recording: !speechRecording }),
    };
  return (
    <div
      className="app"
      data-accent={scenario.accent}
      data-appearance={scenario.appearance}
      style={{ gridTemplateColumns: "minmax(0, 1fr)" }}
    >
      <main className="primary-panel">
        <div className="exchange-panel">
          <div className="composer-dock">
            <form
              className="composer"
              onSubmit={(event) => event.preventDefault()}
            >
              <div className="composer-writing">
                <textarea aria-label="输入草稿" defaultValue="原稿保留" />
              </div>
              <ComposerActionBar
                media={
                  <button className="icon-button" aria-label="添加输入内容">
                    ＋
                  </button>
                }
                settings={
                  <button
                    className="composer-settings-trigger"
                    aria-label="输入设置"
                    aria-pressed="true"
                  >
                    设置
                  </button>
                }
                microphone={
                  <button
                    className="icon-button"
                    aria-label="语音输入"
                    aria-pressed={speechRecording}
                    data-recording={speechRecording || undefined}
                    title={speechRecording ? "停止听写" : "开始听写"}
                    disabled={
                      (sending ||
                        !!draft.pendingSupplement ||
                        !client.online) &&
                      !speechRecording
                    }
                    onClick={inputTools.toggleDictation}
                  >
                    {speechRecording ? <Square /> : <Mic />}
                  </button>
                }
                send={
                  <button className="send" aria-label="发送输入">
                    <Square />
                  </button>
                }
              />
            </form>
          </div>
        </div>
        <div className="exchange-view-tools">
          <button
            className="icon-button"
            aria-label="非听写停止"
            aria-pressed="true"
            data-recording="false"
          >
            <Square />
          </button>
        </div>
      </main>
    </div>
  );
}

Reflect.set(window, "dictationColorFixture", {
  patch: (next: Partial<Scenario>) => patch(next),
  remember: () => {
    remembered = document.querySelector('[aria-label="语音输入"]');
  },
  report: () => {
    const button = document.querySelector<HTMLButtonElement>(
      '[aria-label="语音输入"]',
    )!;
    const svg = button.querySelector("svg")!;
    const style = getComputedStyle(button),
      rect = button.getBoundingClientRect(),
      icon = svg.getBoundingClientRect();
    return {
      same: button === remembered,
      focused: button === document.activeElement,
      focusVisible: button.matches(":focus-visible"),
      label: button.getAttribute("aria-label"),
      pressed: button.getAttribute("aria-pressed"),
      recording: button.getAttribute("data-recording"),
      title: button.title,
      disabled: button.disabled,
      direct: button.parentElement?.className,
      color: style.color,
      iconColor: getComputedStyle(svg).color,
      opacity: style.opacity,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineColor: style.outlineColor,
      background: style.backgroundColor,
      width: rect.width,
      height: rect.height,
      iconWidth: icon.width,
      iconHeight: icon.height,
      glyph: svg.classList.contains("lucide-square") ? "stop" : "microphone",
      draft: document.querySelector("textarea")!.value,
      others: ["添加输入内容", "输入设置", "发送输入", "非听写停止"].map(
        (label) => {
          const control = document.querySelector(`[aria-label="${label}"]`)!;
          return { label, color: getComputedStyle(control).color };
        },
      ),
    };
  },
});
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Fixture />
  </React.StrictMode>,
);
