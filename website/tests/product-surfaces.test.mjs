import assert from "node:assert/strict";
import test from "node:test";
import { productSurfaces } from "../lib/product-surfaces.ts";

test("keeps full Web and restricted preview destinations distinct", () => {
  const beforePersona = process.env.NEXT_PUBLIC_MORPHZ_OFFICIAL_PERSONA_URL;
  const beforeWeb = process.env.NEXT_PUBLIC_MORPHZ_USER_WEB_URL;
  const beforePreview = process.env.NEXT_PUBLIC_MORPHZ_USER_AGENT_PREVIEW_URL;
  const beforeNodeEnv = process.env.NODE_ENV;
  try {
    delete process.env.NEXT_PUBLIC_MORPHZ_OFFICIAL_PERSONA_URL;
    process.env.NEXT_PUBLIC_MORPHZ_USER_WEB_URL = "javascript:alert(1)";
    delete process.env.NEXT_PUBLIC_MORPHZ_USER_AGENT_PREVIEW_URL;
    assert.deepEqual(productSurfaces(), { officialPersona: null, userWeb: null, userPreview: null });
    process.env.NEXT_PUBLIC_MORPHZ_OFFICIAL_PERSONA_URL = "https://chat.morphz.ai/zh";
    process.env.NEXT_PUBLIC_MORPHZ_USER_WEB_URL = "https://app.morphz.ai/";
    process.env.NEXT_PUBLIC_MORPHZ_USER_AGENT_PREVIEW_URL = "https://morphz-cloud-app.shafreeck.workers.dev/zh/agent";
    assert.deepEqual(productSurfaces(), {
      officialPersona: "https://chat.morphz.ai/zh",
      userWeb: "https://app.morphz.ai/",
      userPreview: "https://morphz-cloud-app.shafreeck.workers.dev/zh/agent",
    });
    process.env.NODE_ENV = "production";
    process.env.NEXT_PUBLIC_MORPHZ_OFFICIAL_PERSONA_URL = "http://mbp-m4pro.local:3000/zh/chat";
    assert.equal(productSurfaces().officialPersona, null);
    process.env.NODE_ENV = "development";
    assert.equal(productSurfaces().officialPersona, "http://mbp-m4pro.local:3000/zh/chat");
    assert.equal(productSurfaces().userWeb, "https://app.morphz.ai/");
  } finally {
    if (beforePersona === undefined) delete process.env.NEXT_PUBLIC_MORPHZ_OFFICIAL_PERSONA_URL;
    else process.env.NEXT_PUBLIC_MORPHZ_OFFICIAL_PERSONA_URL = beforePersona;
    if (beforeWeb === undefined) delete process.env.NEXT_PUBLIC_MORPHZ_USER_WEB_URL;
    else process.env.NEXT_PUBLIC_MORPHZ_USER_WEB_URL = beforeWeb;
    if (beforePreview === undefined) delete process.env.NEXT_PUBLIC_MORPHZ_USER_AGENT_PREVIEW_URL;
    else process.env.NEXT_PUBLIC_MORPHZ_USER_AGENT_PREVIEW_URL = beforePreview;
    if (beforeNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = beforeNodeEnv;
  }
});
