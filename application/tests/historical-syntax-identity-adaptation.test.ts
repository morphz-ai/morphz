import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  adaptHistoricalSyntaxIdentity,
  humanPrivateGovernanceHistory,
} from "./fixtures/human-private-governance-history.js";

const helpers = [
  { key: "humanHelper", firstOperand: "    binding.propertyName," },
  { key: "privateHelper", firstOperand: "        statement.parent," },
] as const;

test("historical native syntax diagnostics adapt only the seven reviewed seams without changing archived evidence", () => {
  for (const { key } of helpers) {
    const archived = humanPrivateGovernanceHistory.sources[key]!;
    const adapted = adaptHistoricalSyntaxIdentity(key, archived.raw);
    assert.equal(
      adapted.match(/\bassertSyntaxIdentity\(/g)?.length,
      3,
      "exactly three strict node identities per archived helper",
    );
    assert.notEqual(adapted, archived.raw);
    assert.equal(Buffer.byteLength(archived.raw), archived.bytes);
    assert.equal(
      createHash("sha256").update(archived.raw).digest("hex"),
      archived.sha256,
      "execution adaptation must never rewrite the immutable source",
    );
    if (key === "humanHelper") {
      assert.ok(
        adapted.includes(
          "node === [binding.name, ...consumers.map((value) => value.tagName)][index]",
        ),
        "the original ordered array must compare exact node references",
      );
      assert.ok(
        adapted.includes("[true, ...consumers.map(() => true)]"),
        "the identity slots must retain the exact original array length",
      );
    }
  }
});

test("historical native syntax adaptation rejects missing or repeated reviewed identity calls before execution", () => {
  for (const { key, firstOperand } of helpers) {
    const raw = humanPrivateGovernanceHistory.sources[key]!.raw;
    const message = `historical syntax identity ${key} seam 0 must occur exactly once`;
    assert.throws(
      () =>
        adaptHistoricalSyntaxIdentity(
          key,
          raw.replace(firstOperand, firstOperand + " /* changed operand */"),
        ),
      { name: "AssertionError", message },
    );
    assert.throws(() => adaptHistoricalSyntaxIdentity(key, raw + "\n" + raw), {
      name: "AssertionError",
      message,
    });
  }
});
