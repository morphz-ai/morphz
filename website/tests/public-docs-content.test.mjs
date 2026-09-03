import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const contentRoot = new URL("../content/docs/", import.meta.url);

test("keeps public documentation free of release-preparation and editor notes", async () => {
  const prohibited = {
    zh: /代码仓库公开前|私有 GitHub Release|发布前稳定期|请不要直接编辑|界面应明确|不应凭空生成|默认值支持 43 张|我们/,
    en: /before the repository is public|private GitHub Releases|pre-release stabilization|do not edit it directly|the UI should expose|must not invent|43-screenshot|\b(?:we|our|maintainers?)\b/i,
  };

  for (const locale of ["zh", "en"]) {
    const filenames = (await readdir(new URL(`${locale}/`, contentRoot))).filter((file) => file.endsWith(".md"));
    for (const filename of filenames) {
      const source = await readFile(new URL(`${locale}/${filename}`, contentRoot), "utf8");
      assert.doesNotMatch(source, prohibited[locale], `${locale}/${filename} contains an internal or editorial note`);
    }
  }
});
