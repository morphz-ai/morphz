"use client";

import { useEffect, useRef, useState } from "react";
import type { Locale } from "@/lib/docs";

const labels = {
  zh: { copy: "复制", copied: "已复制", failed: "复制失败" },
  en: { copy: "Copy", copied: "Copied", failed: "Copy failed" },
} as const;

function copyWithSelection(value: string) {
  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  return copied;
}

export function CopyCommand({ command, locale, platform }: { command: string; locale: Locale; platform: string }) {
  const text = labels[locale];
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);

  const copy = async () => {
    let copied = false;

    try {
      if (window.isSecureContext && navigator.clipboard) {
        await navigator.clipboard.writeText(command);
        copied = true;
      } else {
        copied = copyWithSelection(command);
      }
    } catch {
      copied = copyWithSelection(command);
    }

    setState(copied ? "copied" : "failed");
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setState("idle"), 1800);
  };

  const label = state === "copied" ? text.copied : state === "failed" ? text.failed : text.copy;

  return (
    <button
      className="platform-command__copy"
      type="button"
      onClick={copy}
      aria-label={`${text.copy} ${platform} ${locale === "zh" ? "安装命令" : "installation command"}`}
      data-state={state}
    >
      <span className="platform-command__copy-icon" aria-hidden="true" />
      <span aria-live="polite">{label}</span>
    </button>
  );
}
