import { useEffect } from "react";
import type { DesktopAppearanceState } from "./desktop.js";

export function useDesktopAppearance(mode: "system" | "light" | "dark") {
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.appearance = mode;
    const native = window.morphzDesktop?.appearance;
    if (!native) return; // Older desktop shells and browsers keep the solid fallback.
    let alive = true;
    let revision = -1;
    function update(state: DesktopAppearanceState) {
      if (!alive || state.revision < revision) return;
      revision = state.revision;
      root.dataset.nativeMaterial = state.material;
      root.dataset.windowActive = String(state.active);
      root.dataset.reducedTransparency = String(state.reducedTransparency);
      root.dataset.nativeContrast = state.highContrast ? "more" : "normal";
    }
    const unsubscribe = native.onChange(update);
    void native
      .setMode(mode)
      .then(update)
      .catch(() => {
        if (alive) root.dataset.nativeMaterial = "solid";
      });
    return () => {
      alive = false;
      unsubscribe();
      delete root.dataset.nativeMaterial;
      delete root.dataset.windowActive;
      delete root.dataset.reducedTransparency;
      delete root.dataset.nativeContrast;
    };
  }, [mode]);
}
