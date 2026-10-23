/** Intentional failing Node test, launched only by the lifetime regression.
 * The actual packed GUI/SDK/private-port fixture must release its owned
 * Browser/server when Node aborts a timed-out TestContext, not only in finally.
 * No original app, profile, author database or Runtime is involved. */
import test, { before } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCognitiveAppDefinition } from "../../packages/cognitive-app-sdk/src/index.js";
import { openNotesGuiBrowser } from "./cognitive-notes-gui-package.js";

let fixture: Awaited<ReturnType<typeof openNotesGuiBrowser>> | undefined;
const lifetime = new AbortController();
// Safety cleanup for the *negative* regression's supervisor only. Needing this
// signal is a failed assertion in its parent, never a successful abort proof.
process.once("SIGTERM", () => {
  lifetime.abort();
  void (async () => {
    await fixture?.close();
    process.exit(143);
  })();
});

before(
  async (hook) => {
    const abort = () => lifetime.abort(hook.signal.reason);
    hook.signal.addEventListener("abort", abort, { once: true });
    const root = process.env.MORPHZ_TEST_NOTES_GUI_ABORT_ROOT!;
    try {
      fixture = await openNotesGuiBrowser(
        readFileSync(join(root, "dist/notes.html"), "utf8"),
        parseCognitiveAppDefinition(
          JSON.parse(
            readFileSync(join(root, "dist/definition.gui.json"), "utf8"),
          ),
        ),
        { signal: lifetime.signal },
      );
      console.log(
        "NOTES_GUI_ABORT_READY " +
          JSON.stringify({ origin: new URL(fixture.page.url()).origin }),
      );
    } finally {
      hook.signal.removeEventListener("abort", abort);
    }
  },
  { timeout: 30_000 },
);
test(
  "intentional timeout in the actual notes GUI fixture",
  { timeout: 1_000 },
  async (t) => {
    const owned = fixture!;
    // Start the deliberate timeout only after real GUI readiness. Slow startup
    // is a separate hook failure, never mistaken for an abort-cleanup proof.
    const abort = () => lifetime.abort(t.signal.reason);
    t.signal.addEventListener("abort", abort, { once: true });
    try {
      // Deliberately unbounded: Node's test timeout, not Playwright's deadline,
      // must terminate this actual in-flight operation and enter finally.
      await owned.guest.waitForFunction(() => false, undefined, { timeout: 0 });
    } finally {
      await owned.close();
      await owned.close();
      t.signal.removeEventListener("abort", abort);
      console.log(
        "NOTES_GUI_ABORT_CLOSED " +
          JSON.stringify({ connected: owned.browser.isConnected() }),
      );
    }
  },
);
