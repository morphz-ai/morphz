import test from "node:test";
import assert from "node:assert/strict";
import sanitizeHtml from "sanitize-html";
import { safeReadingSection } from "../packages/application/src/reader-import.js";

// GHSA-c9rx-x947-fp3h: discarded iframe fallback text must not recursively
// restart sanitization or reset the configured nesting depth.
test("locked sanitizer and reader safely handle deeply nested discarded iframe fallbacks", () => {
  const fallbacks = "<iframe>".repeat(20_000);
  let clean = "";
  assert.doesNotThrow(() => {
    clean = sanitizeHtml(fallbacks);
  });
  assert.doesNotMatch(clean, /<iframe[\s>]/i);

  const section = safeReadingSection(
    "discarded-iframe",
    "安全原文",
    `<p>保留前文。</p>${fallbacks}`,
  );
  assert.ok(section.text.startsWith("保留前文。\n"));
  assert.match(section.html, /^<p>保留前文。<\/p>/);
  assert.doesNotMatch(section.html, /<iframe[\s>]/i);
});

test("discarded iframe fallbacks cannot bypass the sanitizer nesting limit", () => {
  const input = ("<iframe>" + "<b>".repeat(3)).repeat(50) + "保留文字";
  const clean = sanitizeHtml(input, {
    allowedTags: ["b"],
    nestingLimit: 3,
  });
  let depth = 0;
  let maximumDepth = 0;
  for (const match of clean.matchAll(/<\/?b>/g)) {
    depth += match[0] === "<b>" ? 1 : -1;
    assert.ok(depth >= 0, "sanitized markup must remain balanced");
    maximumDepth = Math.max(maximumDepth, depth);
  }
  assert.equal(depth, 0);
  assert.ok(maximumDepth <= 3, `unexpected nesting depth ${maximumDepth}`);
  assert.ok(clean.includes("保留文字"));
  assert.doesNotMatch(clean, /<iframe[\s>]/i);
});
