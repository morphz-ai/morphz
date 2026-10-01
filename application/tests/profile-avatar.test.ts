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

test("原生头像与品牌轮廓分离，两只眼睛与独立折面保留，三种概念可比较", () => {
  for (const concept of ["seed", "fold", "wing"] as const) {
    const html = renderToStaticMarkup(
      createElement(ProfileAvatar, { name: "阿叶", concept }),
    );
    assert.match(html, new RegExp(`data-concept="${concept}"`));
    assert.match(html, /role="img" aria-label="阿叶"/);
    assert.match(html, /data-avatar-kind="native"/);
    assert.equal((html.match(/<ellipse /g) || []).length, 2);
    assert.match(html, /profile-avatar-fold-left/);
    assert.match(html, /profile-avatar-fold-right/);
    assert.doesNotMatch(
      html,
      /brand-mark|agent-presence-status|tabindex|aria-live/i,
    );
    assert.doesNotMatch(html, /M8 4 48 40/);
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
