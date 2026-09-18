// Native materials belong to the window, never to hosted web pages. The renderer
// can select only the same three appearance modes offered by the app menu.
function windowAppearanceOptions(theme, platform = process.platform) {
  const translucent =
    platform === "darwin" &&
    !theme.prefersReducedTransparency &&
    !theme.shouldUseHighContrastColors;
  return {
    backgroundColor: translucent
      ? "#00000000"
      : theme.shouldUseDarkColors
        ? "#202022"
        : "#fdfdfd",
    ...(translucent
      ? { vibrancy: "sidebar", visualEffectState: "followWindow" }
      : {}),
  };
}

class DesktopAppearance {
  constructor(
    window,
    nativeTheme,
    platform = process.platform,
    initial = null,
  ) {
    this.window = window;
    this.theme = nativeTheme;
    this.platform = platform;
    this.revision = 0;
    this.disposed = false;
    this.applied = initial
      ? {
          vibrancy: initial.vibrancy ?? null,
          background: initial.backgroundColor,
        }
      : null;
    this.published = null;
    this.refresh = () => this.apply();
    this.focus = () => this.publish();
    this.dispose = () => {
      this.disposed = true;
      this.theme.removeListener("updated", this.refresh);
      window.removeListener("focus", this.focus);
      window.removeListener("blur", this.focus);
      window.removeListener("closed", this.dispose);
    };
    nativeTheme.on("updated", this.refresh);
    window.on("focus", this.focus);
    window.on("blur", this.focus);
    window.once("closed", this.dispose);
    this.apply();
  }

  setMode(mode) {
    if (!["system", "light", "dark"].includes(mode))
      throw new Error("外观模式无效。");
    if (this.theme.themeSource !== mode) this.theme.themeSource = mode;
    return this.apply();
  }

  apply() {
    if (this.disposed || this.window.isDestroyed()) return;
    const options = windowAppearanceOptions(this.theme, this.platform);
    this.material = options.vibrancy ? "sidebar" : "solid";
    const next = {
      vibrancy: options.vibrancy ?? null,
      background: options.backgroundColor,
    };
    const previous = this.applied;
    // AppKit may report an appearance update while changing a native material.
    // Remember the entire target before calling either API, so reentrant and
    // repeated notifications cannot rebuild the same visual-effect view.
    this.applied = next;
    try {
      if (this.platform === "darwin" && previous?.vibrancy !== next.vibrancy)
        this.window.setVibrancy(next.vibrancy);
      if (previous?.background !== next.background)
        this.window.setBackgroundColor(next.background);
    } catch (error) {
      this.applied = null; // A failed native update must remain retryable.
      throw error;
    }
    return this.publish();
  }

  publish() {
    if (this.disposed || this.window.isDestroyed()) return;
    const state = {
      material: this.material,
      active: this.window.isFocused(),
      reducedTransparency: !!this.theme.prefersReducedTransparency,
      highContrast: !!this.theme.shouldUseHighContrastColors,
    };
    const signature = JSON.stringify({
      ...state,
      mode: this.theme.themeSource,
      dark: this.theme.shouldUseDarkColors,
    });
    if (signature === this.published) return this.state;
    this.published = signature;
    this.state = { ...state, revision: ++this.revision };
    if (!this.window.webContents.isDestroyed())
      this.window.webContents.send("appearance:changed", this.state);
    return this.state;
  }
}

module.exports = { DesktopAppearance, windowAppearanceOptions };
