import assert from "node:assert/strict";
import test from "node:test";
import { onlineExperiencePublished } from "../lib/public-experience.ts";

test("online experience publication is closed unless explicitly approved", () => {
  for (const value of ["", "false", "1", "TRUE", "preview"]) {
    assert.equal(onlineExperiencePublished(value), false);
  }
  assert.equal(onlineExperiencePublished("true"), true);
});

test("service URLs do not imply publication approval", () => {
  const previous = process.env.NEXT_PUBLIC_MORPHZ_ONLINE_EXPERIENCE_PUBLISHED;
  const keys = ["NEXT_PUBLIC_MORPHZ_OFFICIAL_PERSONA_URL", "NEXT_PUBLIC_MORPHZ_USER_WEB_URL", "NEXT_PUBLIC_MORPHZ_USER_AGENT_PREVIEW_URL"];
  const before = keys.map((key) => process.env[key]);
  try {
    delete process.env.NEXT_PUBLIC_MORPHZ_ONLINE_EXPERIENCE_PUBLISHED;
    for (const key of keys) process.env[key] = "https://example.com/verified-destination";
    assert.equal(onlineExperiencePublished(), false);
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_MORPHZ_ONLINE_EXPERIENCE_PUBLISHED;
    else process.env.NEXT_PUBLIC_MORPHZ_ONLINE_EXPERIENCE_PUBLISHED = previous;
    keys.forEach((key, index) => {
      if (before[index] === undefined) delete process.env[key];
      else process.env[key] = before[index];
    });
  }
});
