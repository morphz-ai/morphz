import test from "node:test";
import assert from "node:assert/strict";
import sanitizeHtml from "sanitize-html";
import {
  parsePublicationRaw,
  safeReadingSection,
} from "../packages/application/src/reader-import.js";
import { epubFiles, zip } from "./fixtures/reader-publication.js";

const animationTags = [
  "animate",
  "animateColor",
  "animateMotion",
  "animateTransform",
  "set",
];
const prefixes = ["", "svg:", "xlink:", "xml:", "SVG:"];
const inertText = "<p>保留原文。</p>";
const animation = (tag: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg"><a href="#safe"><${tag} attributeName="href" values="#safe;javascript:alert(1)" dur=".01s" fill="freeze"></${tag}><text>链接</text></a></svg>`;

test("locked sanitizer rejects namespace-prefixed SMIL URL retargeting", () => {
  // Exercise the dependency's own boundary, not just our stricter reader
  // allowlist. The old 2.17.7 package passes unprefixed cases but fails these
  // prefixed variants, even when only HTTP(S) schemes are permitted.
  for (const prefix of prefixes) {
    for (const localName of animationTags) {
      const tag = `${prefix}${localName}`;
      const clean = sanitizeHtml(`${animation(tag)}${inertText}`, {
        allowedTags: ["svg", "a", "text", "p", tag.toLowerCase()],
        allowedAttributes: false,
        allowedSchemes: ["http", "https"],
      });
      assert.doesNotMatch(
        clean,
        /javascript:|attributeName|attributename/,
        tag,
      );
      assert.ok(clean.endsWith(inertText), tag);
    }
  }
});

test("reader removes SVG animation without dropping text or local links", () => {
  for (const prefix of prefixes) {
    for (const localName of animationTags) {
      const tag = `${prefix}${localName}`;
      const section = safeReadingSection(
        "section-1",
        "安全原文",
        `${animation(tag)}${inertText}<p><a href="#note">注释</a></p><p id="note">注释正文。</p>`,
      );
      assert.doesNotMatch(
        section.html,
        /svg|animate|javascript:|attributeName|attributename|alert/,
        tag,
      );
      assert.equal(section.text, "保留原文。\n注释\n注释正文。\n", tag);
      assert.match(section.html, /<a href="#note">注释<\/a>/, tag);
      assert.match(section.html, /<p id="note">注释正文。<\/p>/, tag);
    }
  }
});

test("EPUB import retains chapters and cross-chapter links after sanitization", async () => {
  const book = await parsePublicationRaw(
    "TEST-sanitizer-regression.epub",
    zip({
      ...epubFiles,
      "OEBPS/a.xhtml": epubFiles["OEBPS/a.xhtml"].replace(
        "</body>",
        `${animation("svg:animate")}</body>`,
      ),
    }),
  );
  assert.equal(book.sections.length, 2);
  assert.match(book.sections[0]!.text, /资治通鉴。/);
  assert.match(book.sections[1]!.text, /这是后文。/);
  assert.match(book.sections[0]!.html, /#reader:section-2:note/);
  for (const section of book.sections)
    assert.doesNotMatch(
      section.html,
      /javascript:|animate|<svg|danger\(\)|tracker\.invalid/,
    );
});
