// Native materials belong to the window, never to hosted web pages. The renderer
// can select only the same three appearance modes offered by the app menu.
class DesktopAppearance {
  constructor(window, nativeTheme, platform = process.platform) {
    this.window = window;
    this.theme = nativeTheme;
    this.platform = platform;
    this.revision = 0;
    this.disposed = false;
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
    const theme = this.theme;
    const solid =
      theme.prefersReducedTransparency || theme.shouldUseHighContrastColors;
    this.material = this.platform === "darwin" && !solid ? "sidebar" : "solid";
    if (this.platform === "darwin")
      this.window.setVibrancy(this.material === "sidebar" ? "sidebar" : null);
    this.window.setBackgroundColor(
      this.material === "sidebar"
        ? "#00000000"
        : theme.shouldUseDarkColors
          ? "#202022"
          : "#fdfdfd",
    );
    return this.publish();
  }

  publish() {
    if (this.disposed || this.window.isDestroyed()) return;
    const state = {
      revision: ++this.revision,
      material: this.material,
      active: this.window.isFocused(),
      reducedTransparency: !!this.theme.prefersReducedTransparency,
      highContrast: !!this.theme.shouldUseHighContrastColors,
    };
    if (!this.window.webContents.isDestroyed())
      this.window.webContents.send("appearance:changed", state);
    return state;
  }
}

module.exports = { DesktopAppearance };
