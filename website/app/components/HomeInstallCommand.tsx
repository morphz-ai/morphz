"use client";

import { useState, useSyncExternalStore } from "react";
import type { Locale } from "@/lib/docs";
import { CopyCommand } from "./CopyCommand";

type Platform = "macos" | "linux" | "windows";

const platforms = {
  macos: {
    label: "macOS",
    command: "curl -fsSL https://morphz.ai/install.sh | sh -s -- setup",
  },
  linux: {
    label: "Linux",
    command: "curl -fsSL https://morphz.ai/install.sh | sh -s -- setup",
  },
  windows: {
    label: "Windows",
    command: "irm https://morphz.ai/install.ps1 | iex\nmorphz setup",
  },
} as const;

const labels = {
  zh: { group: "选择安装平台" },
  en: { group: "Choose an installation platform" },
} as const;

function detectedPlatform(): Platform {
  const value = `${navigator.platform ?? ""} ${navigator.userAgent}`.toLowerCase();
  if (value.includes("win")) return "windows";
  if (value.includes("mac")) return "macos";
  if (value.includes("linux") && !value.includes("android")) return "linux";
  return "macos";
}

const subscribeToPlatform = () => () => {};
const serverPlatform = (): Platform => "macos";

export function HomeInstallCommand({
  locale,
  title,
  release,
  description,
}: {
  locale: Locale;
  title: string;
  release: string;
  description: string;
}) {
  const detected = useSyncExternalStore(subscribeToPlatform, detectedPlatform, serverPlatform);
  const [selectedPlatform, setSelectedPlatform] = useState<Platform | null>(null);
  const platform = selectedPlatform ?? detected;

  const current = platforms[platform];

  return (
    <div className="home-run__command">
      <header>
        <span>{title}</span>
        <div className="home-install__platforms" role="group" aria-label={labels[locale].group}>
          {(Object.keys(platforms) as Platform[]).map((key) => (
            <button
              type="button"
              aria-pressed={platform === key}
              data-active={platform === key ? "true" : "false"}
              onClick={() => setSelectedPlatform(key)}
              key={key}
            >
              {platforms[key].label}
            </button>
          ))}
        </div>
      </header>
      <div className="home-install__code" aria-live="polite">
        <pre><code>{current.command}</code></pre>
        <CopyCommand command={current.command} locale={locale} platform={current.label} />
      </div>
      <footer><strong>{release}</strong><span>{description}</span></footer>
    </div>
  );
}
