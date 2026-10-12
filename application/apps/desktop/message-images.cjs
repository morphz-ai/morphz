const fs = require("node:fs/promises");
const { join, isAbsolute, extname } = require("node:path");

const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function parsePicture(value, nativeImage) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    value.mime !== "image/png" ||
    typeof value.data !== "string" ||
    value.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
    value.data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)
  )
    throw new Error("只接受有界的 PNG 分享图片。");
  const bytes = Buffer.from(value.data, "base64");
  if (bytes.toString("base64") !== value.data)
    throw new Error("分享图片编码无效。");
  if (
    bytes.length < 33 ||
    bytes.length > MAX_IMAGE_BYTES ||
    !bytes.subarray(0, 8).equals(PNG) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  )
    throw new Error("分享图片不是有效的 PNG。");
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  if (
    !width ||
    !height ||
    width > 1440 ||
    height > 3600 ||
    width * height > 6_000_000
  )
    throw new Error("分享图片尺寸过大。");
  const image = nativeImage.createFromBuffer(bytes);
  const size = image.getSize();
  if (image.isEmpty() || size.width !== width || size.height !== height)
    throw new Error("分享图片无法读取。");
  return { bytes, image };
}

/** Main-window-only local output. No caller path, arbitrary MIME, filesystem
 * read, network transmission, Artifact creation or Agent authority is exposed. */
function createMessageImageOutput({
  connection,
  requireMain,
  getWindow,
  dialog,
  nativeImage,
  clipboard,
  ClipboardItem,
}) {
  let generation = 0,
    pending = false;
  const owner = (request, boot) => {
    if (
      boot.centerId !== request.centerId ||
      boot.principalId !== request.principalId
    )
      throw new Error("身份或工作空间已变化，未导出图片。");
  };
  function parse(request, copy) {
    const keys = ["centerId", "principalId", "createdAt", "pictures"];
    if (
      !request ||
      typeof request !== "object" ||
      Array.isArray(request) ||
      Object.keys(request).length !== keys.length ||
      !keys.every((key) => Object.hasOwn(request, key)) ||
      ![request.centerId, request.principalId].every(
        (value) =>
          typeof value === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(value),
      ) ||
      typeof request.createdAt !== "string" ||
      request.createdAt.length > 50 ||
      !Array.isArray(request.pictures) ||
      request.pictures.length < 1 ||
      request.pictures.length > (copy ? 1 : 64)
    )
      throw new Error("分享图片请求无效。");
    let total = 0;
    const pictures = request.pictures.map((picture) => {
      const parsed = parsePicture(picture, nativeImage);
      total += parsed.bytes.length;
      if (total > MAX_TOTAL_BYTES) throw new Error("分享图片总大小过大。");
      return parsed;
    });
    return { ...request, pictures };
  }
  async function output(event, raw, copy) {
    requireMain(event);
    const window = getWindow();
    if (!window || window.isDestroyed() || !window.isFocused() || pending)
      throw new Error("请在当前 Morphz 窗口完成图片操作。");
    const request = parse(raw, copy);
    const current = generation;
    const assertCurrent = () => {
      requireMain(event);
      if (
        current !== generation ||
        window !== getWindow() ||
        window.isDestroyed()
      )
        throw new Error("原窗口已变化，未导出图片。");
    };
    pending = true;
    try {
      owner(request, await connection.call("platform.bootstrap"));
      assertCurrent();
      if (copy) {
        await clipboard.write([
          new ClipboardItem({
            "image/png": new Blob([request.pictures[0].bytes], {
              type: "image/png",
            }),
          }),
        ]);
        return { status: "copied", count: 1 };
      }
      const date = new Date(request.createdAt);
      const suffix = Number.isFinite(date.getTime())
        ? date.toISOString().replace(/[-:]/g, "").slice(0, 15).replace("T", "-")
        : "图片";
      const name = `Morphz-消息-${suffix}`;
      if (request.pictures.length === 1) {
        const chosen = await dialog.showSaveDialog(window, {
          title: "保存分享图片",
          defaultPath: `${name}.png`,
          filters: [{ name: "PNG 图片", extensions: ["png"] }],
        });
        if (chosen.canceled || !chosen.filePath)
          return { status: "cancelled", count: 0 };
        if (
          !isAbsolute(chosen.filePath) ||
          extname(chosen.filePath).toLowerCase() !== ".png"
        )
          throw new Error("请选择 PNG 文件。");
        assertCurrent();
        owner(request, await connection.call("platform.bootstrap"));
        assertCurrent();
        // Exclusive creation cannot overwrite another file or follow a symlink.
        try {
          await fs.writeFile(chosen.filePath, request.pictures[0].bytes, {
            flag: "wx",
            mode: 0o600,
          });
        } catch (error) {
          if (error.code === "EEXIST")
            throw new Error("该文件已存在，请使用另一个名称。原文件未改动。");
          throw error;
        }
        return { status: "saved", count: 1 };
      }
      const chosen = await dialog.showOpenDialog(window, {
        title: "保存全部分享图片",
        properties: ["openDirectory", "createDirectory"],
      });
      if (chosen.canceled || !chosen.filePaths?.[0])
        return { status: "cancelled", count: 0 };
      if (!isAbsolute(chosen.filePaths[0])) throw new Error("保存目录无效。");
      assertCurrent();
      owner(request, await connection.call("platform.bootstrap"));
      assertCurrent();
      // A new, unique child folder prevents collisions without caller paths.
      const directory = await fs.mkdtemp(join(chosen.filePaths[0], `${name}-`));
      const files = [];
      try {
        for (const [index, picture] of request.pictures.entries()) {
          assertCurrent();
          const file = join(
            directory,
            `${String(index + 1).padStart(2, "0")}.png`,
          );
          await fs.writeFile(file, picture.bytes, { flag: "wx", mode: 0o600 });
          files.push(file);
        }
      } catch (error) {
        // Only the exact new output paths from this operation are compensated.
        for (const file of files) await fs.unlink(file);
        await fs.rmdir(directory);
        throw error;
      }
      return { status: "saved", count: files.length };
    } finally {
      pending = false;
    }
  }
  return {
    invalidate() {
      generation++;
    },
    copy(event, request) {
      return output(event, request, true);
    },
    save(event, request) {
      return output(event, request, false);
    },
  };
}

module.exports = { createMessageImageOutput, parsePicture };
