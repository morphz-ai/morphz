import assert from "node:assert/strict";
import test from "node:test";
import { productSurfaces } from "../lib/product-surfaces.ts";

test("publishes only configured secure experience destinations", () => {
  const beforePersona = process.env.NEXT_PUBLIC_MORPHZ_OFFICIAL_PERSONA_URL;
  const beforeWeb = process.env.NEXT_PUBLIC_MORPHZ_USER_WEB_URL;
  try {
    delete process.env.NEXT_PUBLIC_MORPHZ_OFFICIAL_PERSONA_URL;
    process.env.NEXT_PUBLIC_MORPHZ_USER_WEB_URL = "javascript:alert(1)";
    assert.deepEqual(productSurfaces(), { officialPersona: null, userWeb: null });
    process.env.NEXT_PUBLIC_MORPHZ_OFFICIAL_PERSONA_URL = "https://chat.morphz.ai/zh";
    process.env.NEXT_PUBLIC_MORPHZ_USER_WEB_URL = "https://app.morphz.ai/";
    assert.deepEqual(productSurfaces(), {
      officialPersona: "https://chat.morphz.ai/zh",
      userWeb: "https://app.morphz.ai/",
    });
  } finally {
    if (beforePersona === undefined) delete process.env.NEXT_PUBLIC_MORPHZ_OFFICIAL_PERSONA_URL;
    else process.env.NEXT_PUBLIC_MORPHZ_OFFICIAL_PERSONA_URL = beforePersona;
    if (beforeWeb === undefined) delete process.env.NEXT_PUBLIC_MORPHZ_USER_WEB_URL;
    else process.env.NEXT_PUBLIC_MORPHZ_USER_WEB_URL = beforeWeb;
  }
});
