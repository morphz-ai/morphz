import { Palette } from "lucide-react";
import { ComposerOptions } from "./ComposerOptions.js";
import type { InterfacePreferences } from "./interface-preferences.js";

type Props = {
  prefs: InterfacePreferences;
  onPreference: (update: Partial<InterfacePreferences>) => void;
};

/** The quick menu and Settings edit the same values and use the same controls. */
export function AppearanceChoices({
  prefs,
  onPreference,
  onAccent,
}: Props & { onAccent?: () => void }) {
  return (
    <>
      <span className="section-label">外观模式</span>
      <div className="mode-options" role="group" aria-label="外观模式">
        {(["system", "light", "dark"] as const).map((mode) => (
          <button
            key={mode}
            aria-pressed={prefs.appearance === mode}
            onClick={() => onPreference({ appearance: mode })}
          >
            {{ system: "跟随系统", light: "亮色", dark: "暗色" }[mode]}
          </button>
        ))}
      </div>
      <span className="section-label">主题色</span>
      <div className="color-options" role="group" aria-label="主题色">
        {(["cyan", "iris", "coral", "mono"] as const).map((accent) => (
          <button
            key={accent}
            aria-pressed={prefs.accent === accent}
            onClick={() => {
              onPreference({ accent });
              onAccent?.();
            }}
          >
            <span className={`swatch ${accent}`} />
            {
              {
                cyan: "电光青",
                iris: "鸢尾紫",
                coral: "暖珊瑚",
                mono: "纯单色",
              }[accent]
            }
          </button>
        ))}
      </div>
    </>
  );
}

export function AppearanceMenu({
  prefs,
  onPreference,
  onSettings,
}: Props & { onSettings: () => void }) {
  return (
    <ComposerOptions
      label="外观设置"
      menuLabel="外观设置面板"
      below
      triggerClassName="icon-button appearance-trigger"
      triggerIcon={<Palette />}
      menuClassName="appearance-menu"
      options={[]}
      content={(close) => (
        <div className="appearance-settings">
          <AppearanceChoices
            prefs={prefs}
            onPreference={onPreference}
            onAccent={close}
          />
          <button
            className="appearance-more secondary-action"
            onClick={() => {
              close();
              onSettings();
            }}
          >
            更多外观设置
          </button>
        </div>
      )}
    />
  );
}
