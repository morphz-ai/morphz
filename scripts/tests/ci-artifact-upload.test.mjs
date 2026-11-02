import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const metadata = readFileSync(
  new URL(
    "../../.github/actions/upload-ci-artifact/action.yml",
    import.meta.url,
  ),
  "utf8",
);
const official =
  "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9";
const fields = [
  "name",
  "path",
  "if-no-files-found",
  "retention-days",
  "compression-level",
  "include-hidden-files",
  "archive",
];

function contract(source) {
  const blocks = source.split(/^    - /m).slice(1);
  assert.equal(
    blocks.length,
    6,
    "three uploads, two bounded waits, one hard gate",
  );
  const uploads = blocks.filter((block) => block.includes("      uses: "));
  assert.equal(uploads.length, 3);
  for (const [index, id] of ["first", "second", "third"].entries()) {
    const block = uploads[index];
    assert.ok(block.includes(`      id: ${id}\n`));
    assert.ok(block.includes(`      uses: ${official} # v7.0.2\n`));
    const condition =
      index === 0
        ? "always()"
        : index === 1
          ? "always() && steps.first.outcome == 'failure'"
          : "always() && steps.first.outcome == 'failure' && steps.second.outcome == 'failure'";
    assert.ok(block.includes(`      if: \${{ ${condition} }}\n`));
    if (index < 2) assert.match(block, /      continue-on-error: true\n/);
    else assert.doesNotMatch(block, /continue-on-error/);
    for (const field of fields)
      assert.ok(
        block.includes(`        ${field}: \${{ inputs.${field} }}\n`),
        `same ${field}`,
      );
    assert.doesNotMatch(
      block,
      /overwrite:/,
      "recovery never deletes existing evidence",
    );
  }
  assert.match(blocks[1], /      run: sleep 15\n/);
  assert.match(blocks[3], /      run: sleep 30\n/);
  const gate = blocks[5];
  assert.ok(gate.startsWith("name: Require confirmed artifact upload\n"));
  assert.match(gate, /      if: \$\{\{ always\(\) \}\}\n/);
  assert.doesNotMatch(gate, /continue-on-error/);
  for (const [variable, id] of [
    ["FIRST", "first"],
    ["SECOND", "second"],
    ["THIRD", "third"],
  ])
    assert.ok(
      gate.includes(
        `        UPLOAD_${variable}: \${{ steps.${id}.outcome }}\n`,
      ),
    );
  for (const output of ["artifact-id", "artifact-url", "artifact-digest"])
    for (const id of ["first", "second", "third"])
      assert.ok(
        source.includes(
          `(steps.${id}.outcome == 'success' && steps.${id}.outputs.${output})`,
        ),
      );
  assert.doesNotMatch(
    source,
    /\b(?:npm|cargo|gh run|pytest)\b/,
    "transport cannot rerun a test command",
  );
  const script = gate.split("      run: |\n")[1];
  assert.ok(script);
  return script
    .trimEnd()
    .split("\n")
    .map((line) => {
      assert.ok(line.startsWith("        "));
      return line.slice(8);
    })
    .join("\n");
}

function gate(script, outcomes) {
  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      UPLOAD_FIRST: outcomes[0],
      UPLOAD_SECOND: outcomes[1],
      UPLOAD_THIRD: outcomes[2],
    },
  });
  assert.ifError(result.error);
  return result;
}

test("artifact delivery has three pinned identical attempts and a strict final gate", () => {
  contract(metadata);
});

test("the actual delivery shell accepts a confirmed upload and rejects every all-unsuccessful combination", () => {
  const script = contract(metadata);
  const states = ["success", "failure", "skipped", "cancelled"];
  for (const first of states)
    for (const second of states)
      for (const third of states) {
        const outcomes = [first, second, third];
        const result = gate(script, outcomes);
        assert.equal(
          result.status,
          outcomes.includes("success") ? 0 : 1,
          JSON.stringify(outcomes),
        );
      }
});

test("missing or invalid step identities cannot become a confirmed artifact receipt", () => {
  const script = contract(metadata);
  for (const invalid of ["", "unknown", "success; exit 0", "$(exit 0)"])
    assert.equal(gate(script, ["success", invalid, "skipped"]).status, 2);
});

test("delivery topology refuses softened final attempts and incorrect conclusion-based recovery", () => {
  assert.throws(() =>
    contract(
      metadata.replace(
        "      id: third\n",
        "      id: third\n      continue-on-error: true\n",
      ),
    ),
  );
  assert.throws(() =>
    contract(
      metadata.replaceAll("steps.first.outcome", "steps.first.conclusion"),
    ),
  );
  assert.throws(() =>
    contract(metadata.replace("      run: sleep 30", "      run: sleep 300")),
  );
  assert.throws(() =>
    contract(
      metadata.replace(
        "        path: ${{ inputs.path }}",
        "        path: changed-evidence",
      ),
    ),
  );
  const script = contract(metadata);
  assert.notEqual(gate(script, ["failure", "failure", "failure"]).status, 0);
  assert.equal(
    gate(script.replace("exit 1", "exit 0"), ["failure", "failure", "failure"])
      .status,
    0,
    "negative control proves a softened terminal gate is observable",
  );
});

test("all current CI evidence uploads use recovery while the test inventory and native receipt remain mandatory", () => {
  for (const name of [
    "ci.yml",
    "application.yml",
    "application-native-regressions.yml",
    "linux-sandbox-service.yml",
    "conversation-performance-diagnostics.yml",
  ]) {
    const source = readFileSync(
      new URL(`../../.github/workflows/${name}`, import.meta.url),
      "utf8",
    );
    assert.ok(
      source.includes("uses: ./.github/actions/upload-ci-artifact"),
      name,
    );
    assert.doesNotMatch(source, /uses: actions\/upload-artifact@/, name);
  }
  const native = readFileSync(
    new URL(
      "../../.github/workflows/application-native-regressions.yml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    native,
    /assert all\(counts\[key\] == 0 for key in \["failed", "cancelled", "skipped", "todo"\]\)/,
  );
  assert.match(
    native,
    /print\(prefix \+ json\.dumps\(receipt, sort_keys=True\), flush=True\)/,
  );
  assert.match(native, /MOUNTED_RESOURCE_FILE/);
  assert.match(
    native,
    /stream\.read\(1024 \* 1024\)/,
    "large diagnostic files hash in bounded chunks",
  );
  assert.match(
    native,
    /name: intel-mounted-resource-pass-\$\{\{ matrix\.pass \}\}[\s\S]*?if-no-files-found: error/,
  );
});
