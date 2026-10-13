import { MORPHZ_MARK_PATH } from "./BrandMark.js";

export type SharePicture = { blob: Blob; width: number; height: number };
export const shareImageTemplates = [
  { id: "simple", label: "简洁" },
  { id: "card", label: "卡片" },
  { id: "paper", label: "纸笺" },
] as const;
export type ShareImageTemplate = (typeof shareImageTemplates)[number]["id"];
export const SHARE_WIDTH = 600;
export const SHARE_PAGE_HEIGHT = 1520;
const MAX_PAGES = 64;
const MAX_BYTES = 64 * 1024 * 1024;

/** Break at actual rendered lines/rows, never silently crop a long message. */
export function sharePageSlices(
  height: number,
  bands: readonly { top: number; bottom: number }[],
  budget = SHARE_PAGE_HEIGHT,
) {
  if (
    !Number.isFinite(height) ||
    height < 1 ||
    !Number.isFinite(budget) ||
    budget < 100
  )
    throw new Error("消息图片尺寸无效。");
  const slices: { start: number; end: number }[] = [];
  for (let start = 0; start < Math.ceil(height);) {
    let end = Math.min(start + budget, Math.ceil(height));
    if (end < height) {
      const crossing = bands.filter(
        (band) =>
          Number.isFinite(band.top) &&
          Number.isFinite(band.bottom) &&
          band.bottom - band.top <= budget &&
          band.top > start + 1 &&
          band.top < end &&
          band.bottom > end,
      );
      if (crossing.length)
        end = Math.max(
          start + 1,
          Math.floor(Math.min(...crossing.map((b) => b.top))),
        );
    }
    slices.push({ start, end });
    if (slices.length > MAX_PAGES)
      throw new Error(
        "这条消息过长，无法一次生成图片；请分段分享。正文没有被截断。",
      );
    start = end;
  }
  return slices;
}

function check(signal: AbortSignal) {
  signal.throwIfAborted();
}

function pictureReady(image: HTMLImageElement, signal: AbortSignal) {
  check(signal);
  if (image.complete) {
    if (!image.naturalWidth) throw new Error("消息中的图片未能载入，请重试。");
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      image.removeEventListener("load", loaded);
      image.removeEventListener("error", failed);
      signal.removeEventListener("abort", cancelled);
      error ? reject(error) : resolve();
    };
    const loaded = () => finish();
    const failed = () => finish(new Error("消息中的图片未能载入，请重试。"));
    const cancelled = () => finish(signal.reason);
    const timer = setTimeout(
      () => finish(new Error("图片生成超时，请重试。")),
      15000,
    );
    image.addEventListener("load", loaded, { once: true });
    image.addEventListener("error", failed, { once: true });
    signal.addEventListener("abort", cancelled, { once: true });
  });
}

export function shareMessageDate(createdAt: string) {
  const date = new Date(createdAt);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
}

/** Only an already authorized, passive message view is rasterized. No capture,
 * external media, application canvas, API request or business write is performed. */
export async function renderSharePictures(
  source: HTMLElement,
  metadata: {
    author: string;
    createdAt: string;
    partial: boolean;
    template: ShareImageTemplate;
  },
  signal: AbortSignal,
): Promise<SharePicture[]> {
  check(signal);
  await document.fonts.ready;
  check(signal);
  const images = [...source.querySelectorAll("img")];
  for (const image of images) image.loading = "eager";
  await Promise.all(images.map((image) => pictureReady(image, signal)));
  check(signal);
  const bounds = source.getBoundingClientRect();
  const zoom = bounds.width / source.offsetWidth;
  const contentHeight = Math.ceil(bounds.height / zoom);
  if (
    source.offsetWidth !== SHARE_WIDTH ||
    !Number.isFinite(zoom) ||
    zoom <= 0 ||
    contentHeight < 1
  )
    throw new Error("消息尚未排版完成，请重试。");
  const bands: { top: number; bottom: number }[] = [];
  const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    if (!walker.currentNode.textContent?.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(walker.currentNode);
    for (const rect of range.getClientRects())
      bands.push({
        top: (rect.top - bounds.top) / zoom,
        bottom: (rect.bottom - bounds.top) / zoom,
      });
  }
  for (const element of source.querySelectorAll("img, tr")) {
    const rect = element.getBoundingClientRect();
    bands.push({
      top: (rect.top - bounds.top) / zoom,
      bottom: (rect.bottom - bounds.top) / zoom,
    });
  }
  const slices = sharePageSlices(contentHeight, bands);
  const clone = source.cloneNode(true) as HTMLElement;
  const originals = [source, ...source.querySelectorAll<HTMLElement>("*")];
  const copies = [clone, ...clone.querySelectorAll<HTMLElement>("*")];
  for (let index = 0; index < originals.length; index++) {
    const original = originals[index]!,
      copy = copies[index]!;
    const style = getComputedStyle(original);
    for (const property of style)
      copy.style.setProperty(property, style.getPropertyValue(property));
    for (const attribute of [...copy.attributes]) {
      if (/^(?:data-|on|id$|tabindex$|href$|srcset$)/i.test(attribute.name))
        copy.removeAttribute(attribute.name);
    }
    copy.style.animation = "none";
    copy.style.transition = "none";
    if (original instanceof HTMLImageElement) {
      // Reuse the authorized local image already rendered above, not its URL.
      const canvas = document.createElement("canvas");
      canvas.width = original.naturalWidth;
      canvas.height = original.naturalHeight;
      if (canvas.width * canvas.height > 16_000_000)
        throw new Error("消息中的图片过大，无法生成分享图片。");
      const context = canvas.getContext("2d");
      if (!context) throw new Error("当前环境无法生成图片。");
      context.drawImage(original, 0, 0);
      (copy as HTMLImageElement).src = canvas.toDataURL("image/png");
    }
  }
  const markup = new XMLSerializer().serializeToString(clone);
  const style = getComputedStyle(source);
  const ink = style.color;
  const paper = style.backgroundColor;
  const swatch = document.createElement("span");
  swatch.style.color = "var(--muted)";
  swatch.style.backgroundColor = "var(--share-frame)";
  swatch.style.borderColor = "var(--line)";
  source.append(swatch);
  const swatchStyle = getComputedStyle(swatch);
  const muted = swatchStyle.color,
    frame = swatchStyle.backgroundColor,
    line = swatchStyle.borderTopColor;
  swatch.style.color = "var(--accent-strong)";
  const accent = getComputedStyle(swatch).color;
  swatch.remove();
  const font = style.fontFamily;
  const pictures: SharePicture[] = [];
  let bytes = 0;
  const stationery = metadata.template === "paper";
  for (const [index, slice] of slices.entries()) {
    check(signal);
    const bodyHeight = slice.end - slice.start;
    const footer = metadata.partial || slices.length > 1;
    const bodyTop = stationery ? 40 : 104;
    const width = SHARE_WIDTH + 104,
      height =
        bodyHeight + (stationery ? (footer ? 136 : 112) : footer ? 176 : 148);
    const canvas = document.createElement("canvas");
    canvas.width = width * 2;
    canvas.height = height * 2;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前环境无法生成图片。");
    context.scale(2, 2);
    // Independent document typography; the palette still follows the App's
    // effective appearance. Template choices never change that App preference.
    context.fillStyle = metadata.template === "card" ? frame : paper;
    context.fillRect(0, 0, width, height);
    if (metadata.template === "card") {
      context.fillStyle = paper;
      context.beginPath();
      context.roundRect(20, 20, width - 40, height - 40, 14);
      context.fill();
    }
    // Card keeps its existing branded heading. Stationery starts with the
    // actual message and signs it below the body, not another tinted card.
    const brandY = stationery ? height - (footer ? 54 : 30) : 59;
    context.save();
    context.translate(52, stationery ? brandY - 15 : 43);
    context.scale((stationery ? 16 : 20) / 96, (stationery ? 16 : 20) / 96);
    context.fillStyle = accent;
    context.fill(new Path2D(MORPHZ_MARK_PATH));
    context.restore();
    context.fillStyle = stationery ? muted : ink;
    context.font = `600 ${stationery ? 12 : 16}px ${font}`;
    context.fillText("Morphz", stationery ? 76 : 82, brandY);
    if (metadata.author !== "Morphz") {
      context.fillStyle = muted;
      context.font = `13px ${font}`;
      const author = Array.from(metadata.author.replace(/[\r\n]/g, " "));
      let name = author.join("");
      while (author.length && context.measureText(name).width > 240) {
        author.pop();
        name = `${author.join("")}…`;
      }
      context.fillText(name, stationery ? 134 : 156, stationery ? brandY : 58);
    }
    context.fillStyle = muted;
    context.textAlign = "right";
    context.font = `12px ${font}`;
    context.fillText(
      shareMessageDate(metadata.createdAt),
      width - 52,
      stationery ? brandY : 58,
    );
    context.textAlign = "left";
    context.strokeStyle = line;
    context.lineWidth = 1;
    context.beginPath();
    const ruleY = stationery ? bodyTop + bodyHeight + 20.5 : 81.5;
    context.moveTo(52, ruleY);
    context.lineTo(width - 52, ruleY);
    context.stroke();
    const image = new Image();
    image.src =
      "data:image/svg+xml;charset=utf-8," +
      encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${SHARE_WIDTH}" height="${bodyHeight}"><foreignObject x="0" y="${-slice.start}" width="${SHARE_WIDTH}" height="${contentHeight}">${markup}</foreignObject></svg>`,
      );
    await pictureReady(image, signal);
    check(signal);
    context.drawImage(image, 52, bodyTop);
    context.fillStyle = muted;
    context.font = `13px ${font}`;
    if (metadata.partial)
      context.fillText(
        "当前已显示内容（未完成）",
        52,
        height - (stationery ? 30 : 46),
      );
    if (slices.length > 1) {
      context.textAlign = "right";
      context.fillText(
        `${index + 1} / ${slices.length}`,
        width - 52,
        height - (stationery ? 30 : 46),
      );
    }
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) =>
          value ? resolve(value) : reject(new Error("图片生成失败，请重试。")),
        "image/png",
      ),
    );
    check(signal);
    bytes += blob.size;
    if (blob.size > 16 * 1024 * 1024 || bytes > MAX_BYTES)
      throw new Error("分享图片过大，请分段分享。正文没有被截断。");
    pictures.push({ blob, width: canvas.width, height: canvas.height });
    canvas.width = canvas.height = 0;
  }
  return pictures;
}

export function pngBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("无法读取分享图片。"));
    reader.onload = () => resolve(String(reader.result).split(",")[1]!);
    reader.readAsDataURL(blob);
  });
}
