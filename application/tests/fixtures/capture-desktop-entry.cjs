// Use the production window, picker and IPC against an isolated center/profile.
// Only the final OS pixel read is replaced; never capture the user's desktop.
const { writeFile } = require("node:fs/promises");
const captureModule = require("../../apps/desktop/capture.cjs");
const OriginalCapture = captureModule.DesktopCapture;
globalThis.__captureWindowFixture = { reads: [], fail: false };
captureModule.DesktopCapture = class extends OriginalCapture {
  constructor(options) {
    super({
      ...options,
      runner: async (_command, args) => {
        const state = globalThis.__captureWindowFixture;
        state.reads.push({ visible: options.getWindow().isVisible() });
        if (state.fail) throw new Error("Simulated capture failure");
        await writeFile(
          args.at(-1),
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKp8AAAAASUVORK5CYII=",
            "base64",
          ),
        );
      },
    });
  }
};
require("./production-desktop-entry.cjs");
