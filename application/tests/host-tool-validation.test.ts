import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { hostToolValidationFailure } from "../packages/application/src/host-tool-validation.js";

test("Host argument errors retain bounded field-level shape diagnostics, not rejected values", () => {
  const parsed = z
    .object({
      arguments: z
        .object({
          limit: z.number().max(8000),
          revision: z.number(),
        })
        .strict(),
    })
    .safeParse({
      arguments: {
        limit: 11000,
        revision: "SECRET_ARGUMENT_VALUE",
        sectionId: "PRIVATE_BOOK_VALUE",
        start: 7900,
      },
    });
  assert.equal(parsed.success, false);
  if (parsed.success) throw Error("Expected invalid arguments");
  const failure = hostToolValidationFailure(parsed.error);
  assert.equal(failure.ok, false);
  assert.equal(failure.code, "invalid");
  assert.match(failure.message, /未执行操作/);
  assert.match(failure.message, /list／describe/);
  assert.ok(
    failure.issues.some(
      (issue) =>
        issue.path.join(".") === "arguments.limit" && issue.maximum === 8000,
    ),
  );
  assert.ok(
    failure.issues.some(
      (issue) =>
        issue.path.join(".") === "arguments.revision" &&
        issue.expected === "number",
    ),
  );
  assert.ok(failure.issues.some((issue) => issue.keys?.includes("sectionId")));
  assert.doesNotMatch(
    JSON.stringify(failure),
    /SECRET_ARGUMENT_VALUE|PRIVATE_BOOK_VALUE|stack/,
  );
  const many = z.array(z.number()).safeParse(Array(20).fill("PRIVATE"));
  if (many.success) throw Error("Expected invalid array");
  const bounded = hostToolValidationFailure(many.error);
  assert.equal(bounded.issues.length, 8);
  assert.equal(bounded.issuesTruncated, true);
});
