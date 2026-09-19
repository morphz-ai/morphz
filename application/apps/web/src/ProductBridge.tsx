import { BrandMark } from "./BrandMark.js";

/** Product-family navigation belongs to Web chrome, not the embedded Desktop app. */
function publishedDestination(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
      return url.toString();
    }
  } catch {
    // A site without a verified public deployment must not offer a dead link.
  }
  return null;
}

export function ProductBridge({ productHomeUrl, officialUrl }: { productHomeUrl?: string; officialUrl?: string }) {
  const productHome = publishedDestination(productHomeUrl);
  const official = publishedDestination(officialUrl);
  return (
    <div className="product-bridge" aria-label="Morphz 产品入口">
      <span><BrandMark /> 当前：我的 Agent</span>
      {productHome ? <a href={productHome} target="_blank" rel="noopener noreferrer">产品与开源 <b aria-hidden="true">↗</b></a> : <small>产品主页上线后开放入口</small>}
      {official && <a href={official} target="_blank" rel="noopener noreferrer">认识官方 Morphz <b aria-hidden="true">↗</b></a>}
      <small>你的工作空间与官方 Morphz 的共享认知彼此独立。</small>
    </div>
  );
}
