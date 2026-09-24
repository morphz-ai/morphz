import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";

const { createReadingOcrEngine } = createRequire(import.meta.url)(
  "../apps/desktop/reader-ocr.cjs",
);

for (const outcome of ["complete", "cancel", "failed"] as const) {
  test(`OCR ${outcome} 后销毁窗口、移除 IPC 并释放隔离分区闭包中的模型`, async () => {
    const abort = new AbortController();
    let protocol!: (request: Request) => Promise<Response>;
    let receive: ((event: unknown, message: unknown) => unknown) | undefined;
    let destroyed = false,
      unhandled = false,
      cleared = false;
    const isolated = {
      setPermissionRequestHandler() {},
      setPermissionCheckHandler() {},
      webRequest: { onBeforeRequest() {} },
      on() {},
      protocol: {
        handle(_name: string, handler: typeof protocol) {
          protocol = handler;
        },
        unhandle() {
          unhandled = true;
          // Retain the callback as a native partition may do. The completed
          // job must release its payload independently of session destruction.
        },
      },
      async clearCache() {
        cleared = true;
      },
    };
    const pdf = new Uint8Array([1, 2, 3]);
    const model = new Uint8Array([4, 5, 6]);
    class Window extends EventEmitter {
      webContents = Object.assign(new EventEmitter(), {
        mainFrame: { url: "morphz://app/ocr.html" },
        setWindowOpenHandler() {},
      });
      isDestroyed() {
        return destroyed;
      }
      destroy() {
        destroyed = true;
        this.emit("closed");
      }
      async loadURL() {
        const response = await protocol(
          new Request("morphz://app/ocr-model/0.tar"),
        );
        assert.equal(response.status, 200);
        assert.deepEqual(new Uint8Array(await response.arrayBuffer()), model);
        const event = {
          sender: this.webContents,
          senderFrame: this.webContents.mainFrame,
        };
        assert.deepEqual(receive!(event, { type: "ready" }), { pdf, page: 1 });
        if (outcome === "cancel") abort.abort();
        else
          receive!(event, {
            type: outcome === "complete" ? "result" : "failed",
            result: { items: [] },
          });
      }
    }
    const engine = createReadingOcrEngine({
      BrowserWindow: Window,
      session: { fromPartition: () => isolated },
      ipcMain: {
        handle(_channel: string, handler: typeof receive) {
          receive = handler;
        },
        removeHandler() {
          receive = undefined;
        },
      },
      resources() {
        throw new Error("Unexpected resource access");
      },
    });
    const running = engine(
      { pdf, page: 1, models: [model, model] },
      abort.signal,
    );
    if (outcome === "complete") assert.deepEqual(await running, { items: [] });
    else
      await assert.rejects(
        running,
        /OCR cancelled|Local OCR initialization failed/,
      );
    assert.ok(destroyed && unhandled && cleared);
    assert.equal(receive, undefined);
    const late = await protocol(new Request("morphz://app/ocr-model/0.tar"));
    assert.equal(
      late.status,
      403,
      "A completed job must no longer retain its model payload",
    );
  });
}
