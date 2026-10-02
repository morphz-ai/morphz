import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ProfileAvatar,
  profileAvatarInitial,
  profileAvatarSize,
  type ProfileAvatarState,
} from "../apps/web/src/ProfileAvatar.js";

test("头像尺寸稳定，姓名首字支持中文和 Unicode，不借名字猜状态", () => {
  assert.equal(profileAvatarInitial("  小林 "), "小");
  assert.equal(profileAvatarInitial("🪴 阿叶"), "🪴");
  assert.equal(profileAvatarInitial("morphz"), "M");
  assert.equal(profileAvatarInitial("  "), "M");
  assert.equal(profileAvatarSize(), 96);
  assert.equal(profileAvatarSize(24), 24);
  assert.equal(profileAvatarSize(0), 16);
  assert.equal(profileAvatarSize(900), 512);
  assert.equal(profileAvatarSize(Number.NaN), 96);
  assert.equal(profileAvatarSize(Number.POSITIVE_INFINITY), 96);
});

test("默认 Agent 头像复用真实 Morphz Logo，不再使用卡通角色", () => {
  for (const size of [18, 32, 96]) {
    const html = renderToStaticMarkup(
      createElement(ProfileAvatar, { name: "阿叶", size, allowMotion: false }),
    );
    assert.match(html, /role="img" aria-label="阿叶"/);
    assert.match(html, /data-avatar-kind="native"/);
    assert.match(html, /class="brand-mark"/);
    assert.match(
      html,
      /M8 4 48 40 38 40 38 70 8 92Z M88 4 48 40 58 40 58 70 88 92Z/,
    );
    assert.match(html, /data-motion="off"/);
    assert.doesNotMatch(
      html,
      /ellipse|profile-avatar-face|profile-avatar-fold|data-concept|brand-mark-glint|agent-presence-status|tabindex|aria-live/i,
    );
  }
});

test("真实状态由调用者提供，未知不声称离线，没有额外文字下标", () => {
  const states: ProfileAvatarState[] = [
    "idle",
    "processing",
    "working",
    "approval",
    "paused",
    "waiting",
    "offline",
    "unavailable",
  ];
  for (const state of states) {
    const html = renderToStaticMarkup(
      createElement(ProfileAvatar, {
        name: "阿叶",
        state,
        label: `阿叶：实际 ${state}`,
        size: 32,
      }),
    );
    assert.match(html, new RegExp(`data-state="${state}"`));
    assert.match(html, /data-small="true"/);
    assert.match(html, new RegExp(`aria-label="阿叶：实际 ${state}"`));
    assert.doesNotMatch(html, /<text|<small|role="status"/);
    if (state === "offline" || state === "unavailable")
      assert.match(html, /data-motion="off"/);
  }
});

test("静态照片保持静态，动态图减少动态时使用 poster，无 poster 回到首字", () => {
  const still = renderToStaticMarkup(
    createElement(ProfileAvatar, {
      name: "小林",
      src: "/assets/still.png",
      state: "working",
    }),
  );
  assert.match(still, /<img/);
  assert.doesNotMatch(still, /<svg|<video|profile-avatar-face/);
  assert.match(still, /data-motion="off"/);

  for (const constraint of [
    { allowMotion: false },
    { active: false },
    { state: "unavailable" as const },
  ]) {
    const poster = renderToStaticMarkup(
      createElement(ProfileAvatar, {
        name: "小林",
        src: "/assets/dynamic.gif",
        animated: true,
        posterSrc: "/assets/poster.png",
        ...constraint,
      }),
    );
    assert.match(poster, /src="\/assets\/poster.png"/);
    assert.doesNotMatch(poster, /src="\/assets\/dynamic.gif"|<video/);
    const fallback = renderToStaticMarkup(
      createElement(ProfileAvatar, {
        name: "小林",
        src: "/assets/dynamic.webm",
        mediaType: "video",
        ...constraint,
      }),
    );
    assert.match(fallback, /data-avatar-kind="initial"/);
    assert.match(fallback, />小<\/span>/);
    assert.doesNotMatch(fallback, /<img|<video|src="/);
  }
});
