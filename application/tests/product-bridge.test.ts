import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProductBridge } from "../apps/web/src/ProductBridge.js";

test("Web product bridge keeps private and official Agents distinct", () => {
  const html = renderToStaticMarkup(createElement(ProductBridge, {}));
  assert.match(html, /当前：我的 Agent/);
  assert.doesNotMatch(html, /https:\/\/morphz\.ai\/experience/);
  assert.match(html, /产品主页上线后开放入口/);
  assert.match(html, /你的工作空间与官方 Morphz 的共享认知彼此独立/);
  assert.doesNotMatch(html, /认识官方 Morphz/);
});

test("product hub link appears only after its actual URL is configured", () => {
  assert.doesNotMatch(renderToStaticMarkup(createElement(ProductBridge, { productHomeUrl: "javascript:alert(1)" })), /href="javascript:/);
  assert.match(renderToStaticMarkup(createElement(ProductBridge, { productHomeUrl: "https://morphz.ai/experience" })), /href="https:\/\/morphz\.ai\/experience"/);
});

test("official-persona link appears only for a configured safe deployment", () => {
  assert.doesNotMatch(renderToStaticMarkup(createElement(ProductBridge, { officialUrl: "javascript:alert(1)" })), /认识官方 Morphz/);
  assert.match(renderToStaticMarkup(createElement(ProductBridge, { officialUrl: "https://chat.morphz.ai/zh" })), /认识官方 Morphz/);
});
