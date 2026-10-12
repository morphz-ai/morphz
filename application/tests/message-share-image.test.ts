import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sharePageSlices,
  shareMessageDate,
  SHARE_PAGE_HEIGHT,
} from "../apps/web/src/message-share-image.js";
const require = createRequire(import.meta.url);
const {
  createMessageImageOutput,
  parsePicture,
} = require("../apps/desktop/message-images.cjs");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const picture = { mime: "image/png", data: png.toString("base64") };
// Electron 44 uses asynchronous MIME-typed ClipboardItem writes. The native
// acceptance still has to exercise the real system clipboard, not this seam.
class ClipboardItem {
  constructor(readonly data: Record<string, Blob>) {}
}
// The decoder seam does not claim an Electron/native-image integration test.
const nativeImage = {
  createFromBuffer: (bytes: Buffer) => ({
    isEmpty: () => false,
    getSize: () => ({
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
    }),
  }),
};

test("消息分页连续覆盖全文并避开文字行／表格行，不暗中截断", () => {
  const slices = sharePageSlices(
    4700,
    [
      { top: 1580, bottom: 1610 },
      { top: 3100, bottom: 3250 },
    ],
    1600,
  );
  assert.equal(slices[0]!.start, 0);
  assert.equal(slices[0]!.end, 1580);
  assert.equal(slices[1]!.end, 3100);
  assert.equal(slices.at(-1)!.end, 4700);
  for (let index = 1; index < slices.length; index++)
    assert.equal(slices[index]!.start, slices[index - 1]!.end);
  assert.ok(
    slices.every(
      (slice) => slice.end - slice.start <= 1600 && slice.end > slice.start,
    ),
  );
  assert.ok(
    sharePageSlices(4700, []).every(
      (slice) => slice.end - slice.start <= SHARE_PAGE_HEIGHT,
    ),
  );
  assert.throws(() => sharePageSlices(SHARE_PAGE_HEIGHT * 65, []), /过长/);
  assert.throws(() => sharePageSlices(NaN, []), /无效/);
  assert.equal(shareMessageDate("invalid"), "");
});

test("PNG边界拒绝任意MIME、额外字段、无效编码、巨型尺寸与解码失败", () => {
  assert.deepEqual(parsePicture(picture, nativeImage).bytes, png);
  for (const value of [
    { ...picture, path: "/tmp/escape" },
    { ...picture, mime: "text/html" },
    { ...picture, data: "invalid" },
    { ...picture, data: Buffer.from("<svg/>").toString("base64") },
  ])
    assert.throws(() => parsePicture(value, nativeImage));
  const oversized = Buffer.from(png);
  oversized.writeUInt32BE(20_000, 16);
  assert.throws(
    () =>
      parsePicture(
        { ...picture, data: oversized.toString("base64") },
        nativeImage,
      ),
    /尺寸/,
  );
  assert.throws(
    () =>
      parsePicture(picture, {
        createFromBuffer: () => ({
          isEmpty: () => true,
          getSize: () => ({ width: 1, height: 1 }),
        }),
      }),
    /无法读取/,
  );
});

function fixture(directory: string) {
  const event = {};
  const window = { isDestroyed: () => false, isFocused: () => effects.focused };
  const effects = {
    copies: 0,
    dialogs: 0,
    bootReads: 0,
    principal: "TEST-owner",
    focused: true,
  };
  const choose = {
    filePath: join(directory, "TEST-share.png"),
    canceled: false,
    filePaths: [directory],
  };
  const service = createMessageImageOutput({
    connection: {
      call: async () => {
        effects.bootReads++;
        return { centerId: "TEST-center", principalId: effects.principal };
      },
    },
    requireMain: (value: unknown) => {
      if (value !== event) throw new Error("not trusted main");
    },
    getWindow: () => window,
    dialog: {
      showSaveDialog: async () => {
        effects.dialogs++;
        return choose;
      },
      showOpenDialog: async () => {
        effects.dialogs++;
        return choose;
      },
    },
    nativeImage,
    ClipboardItem,
    clipboard: {
      write: async () => {
        effects.copies++;
      },
    },
  });
  return {
    service,
    event,
    effects,
    choose,
    request: {
      centerId: "TEST-center",
      principalId: "TEST-owner",
      createdAt: "2026-10-12T12:00:00Z",
      pictures: [picture],
    },
  };
}

test("图片复制仅当前受信主窗口和原身份，拒绝额外路径及多个剪贴板图片", async () => {
  const directory = await mkdtemp(join(tmpdir(), "morphz-share-test-"));
  try {
    const f = fixture(directory);
    await assert.rejects(f.service.copy({}, f.request), /not trusted/);
    await assert.rejects(
      f.service.copy(f.event, { ...f.request, path: directory }),
      /无效/,
    );
    await assert.rejects(
      f.service.copy(f.event, { ...f.request, pictures: [picture, picture] }),
      /无效/,
    );
    f.effects.focused = false;
    await assert.rejects(f.service.copy(f.event, f.request), /当前/);
    f.effects.focused = true;
    f.effects.principal = "TEST-other";
    await assert.rejects(f.service.copy(f.event, f.request), /身份/);
    assert.equal(f.effects.copies, 0);
    assert.equal(f.effects.dialogs, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("保存使用原生确认选择；单张和分页目录精确保存PNG，取消不写，绝不覆盖现有文件", async () => {
  const directory = await mkdtemp(join(tmpdir(), "morphz-share-output-"));
  try {
    const event = {},
      window = { isDestroyed: () => false, isFocused: () => true };
    let cancelled = false,
      copies = 0;
    const file = join(directory, "TEST-share.png");
    const service = createMessageImageOutput({
      connection: {
        call: async () => ({
          centerId: "TEST-center",
          principalId: "TEST-owner",
        }),
      },
      requireMain: (value: unknown) => {
        assert.equal(value, event);
      },
      getWindow: () => window,
      dialog: {
        showSaveDialog: async () => ({ canceled: cancelled, filePath: file }),
        showOpenDialog: async () => ({
          canceled: cancelled,
          filePaths: [directory],
        }),
      },
      nativeImage,
      ClipboardItem,
      clipboard: {
        write: async () => {
          copies++;
        },
      },
    });
    const request = {
      centerId: "TEST-center",
      principalId: "TEST-owner",
      createdAt: "2026-10-12T12:00:00Z",
      pictures: [picture],
    };
    assert.deepEqual(await service.copy(event, request), {
      status: "copied",
      count: 1,
    });
    assert.equal(copies, 1);
    cancelled = true;
    assert.deepEqual(await service.save(event, request), {
      status: "cancelled",
      count: 0,
    });
    assert.deepEqual(await readdir(directory), []);
    cancelled = false;
    assert.deepEqual(await service.save(event, request), {
      status: "saved",
      count: 1,
    });
    assert.deepEqual(await readFile(file), png);
    await assert.rejects(service.save(event, request), /原文件未改动/);
    assert.deepEqual(await readFile(file), png);
    assert.deepEqual(
      await service.save(event, { ...request, pictures: [picture, picture] }),
      { status: "saved", count: 2 },
    );
    const folder = (await readdir(directory)).find((entry) =>
      entry.startsWith("Morphz-消息-"),
    )!;
    assert.deepEqual(await readdir(join(directory, folder)), [
      "01.png",
      "02.png",
    ]);
    assert.deepEqual(await readFile(join(directory, folder, "02.png")), png);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("原生选择期间身份变化、窗口刷新或销毁均阻止落盘，预览字节不会执行", async () => {
  const directory = await mkdtemp(join(tmpdir(), "morphz-share-boundary-"));
  try {
    for (const mode of ["identity", "reload", "destroy"] as const) {
      const event = {},
        window = { isDestroyed: () => destroyed, isFocused: () => true };
      let owner = "TEST-owner",
        destroyed = false;
      const file = join(directory, `TEST-${mode}.png`);
      const service = createMessageImageOutput({
        connection: {
          call: async () => ({ centerId: "TEST-center", principalId: owner }),
        },
        requireMain: () => {},
        getWindow: () => window,
        dialog: {
          showSaveDialog: async () => {
            if (mode === "identity") owner = "TEST-other";
            if (mode === "reload") service.invalidate();
            if (mode === "destroy") destroyed = true;
            return { canceled: false, filePath: file };
          },
        },
        nativeImage,
        ClipboardItem,
        clipboard: { write: async () => assert.fail("unexpected clipboard") },
      });
      await assert.rejects(
        service.save(event, {
          centerId: "TEST-center",
          principalId: "TEST-owner",
          createdAt: "invalid",
          pictures: [picture],
        }),
        /身份|窗口/,
      );
    }
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("图片复制只写固定PNG格式，等待系统完成；异步失败不能提前报告成功", async () => {
  const event = {},
    window = { isDestroyed: () => false, isFocused: () => true };
  let finish!: () => void,
    settled = false,
    failWrite = false;
  const pending = new Promise<void>((resolve) => (finish = resolve));
  const service = createMessageImageOutput({
    connection: {
      call: async () => ({
        centerId: "TEST-center",
        principalId: "TEST-owner",
      }),
    },
    requireMain: (value: unknown) => assert.equal(value, event),
    getWindow: () => window,
    dialog: {},
    nativeImage,
    ClipboardItem,
    clipboard: {
      write: async (items: ClipboardItem[]) => {
        assert.equal(items.length, 1);
        assert.ok(items[0] instanceof ClipboardItem);
        assert.deepEqual(Object.keys(items[0]!.data), ["image/png"]);
        const blob = items[0]!.data["image/png"]!;
        assert.equal(blob.type, "image/png");
        assert.deepEqual(Buffer.from(await blob.arrayBuffer()), png);
        if (failWrite) throw new Error("TEST system clipboard rejected");
        await pending;
      },
    },
  });
  const request = {
    centerId: "TEST-center",
    principalId: "TEST-owner",
    createdAt: "invalid",
    pictures: [picture],
  };
  const copied = service.copy(event, request).then((value: unknown) => {
    settled = true;
    return value;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  finish();
  assert.deepEqual(await copied, { status: "copied", count: 1 });
  failWrite = true;
  await assert.rejects(
    service.copy(event, request),
    /system clipboard rejected/,
  );
});
