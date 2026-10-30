import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../../.github/workflows/application.yml", import.meta.url), "utf8");
const preparation = "npm exec --offline -- tsx scripts/prepare-cognitive-author-dependencies.ts";
const cache = 'printf \'MORPHZ_TEST_COGNITIVE_NPM_CACHE=%s/morphz-cognitive-npm-cache\\n\' "$RUNNER_TEMP" >> "$GITHUB_ENV"';
const jobs = ["web-node", "web-browser", "storage-postgres", "desktop", "cognitive-runtime-contract"];

function jobSource(source, name) {
  const header = `\n  ${name}:\n`;
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `missing ${name} job`);
  const tail = source.slice(start + header.length);
  const next = tail.search(/^  [a-z][a-z0-9-]*:\s*$/m);
  return next === -1 ? tail : tail.slice(0, next);
}

function verify(source) {
  for (const name of jobs) {
    const job = jobSource(source, name);
    const steps = job.indexOf("    steps:\n");
    assert.ok(steps > 0, `${name}: steps missing`);
    assert.doesNotMatch(job.slice(0, steps), /\$\{\{\s*runner\./, `${name}: runner context is unavailable in job env`);
    const cacheSetup = job.indexOf(cache, steps);
    assert.ok(cacheSetup > steps, `${name}: private cache setup missing`);
    const install = job.indexOf("      - run: npm ci\n", steps);
    const prepare = job.indexOf(preparation, steps);
    assert.ok(install > cacheSetup && prepare > install, `${name}: prepare must follow cache setup and npm ci`);
    assert.equal(job.split(preparation).length, 2, `${name}: prepare exactly once`);
    const firstConsumer = name === "cognitive-runtime-contract"
      ? job.indexOf("npm exec --offline -- node scripts/ci-cognitive-runtime.mjs", steps)
      : name === "web-browser" ? job.indexOf("npm run test:e2e", steps) : job.search(/\bnpm test\b/);
    assert.ok(firstConsumer > prepare, `${name}: prepare before independent consumers`);
    if (["web-node", "storage-postgres", "desktop"].includes(name)) {
      const dashboard = job.indexOf("npm ci --prefix ../dashboard", steps);
      assert.ok(dashboard > install && dashboard < firstConsumer, `${name}: actual Dashboard component dependencies must precede the full Node inventory`);
      const dashboardStep = job.slice(job.lastIndexOf("      - ", dashboard), job.indexOf("\n      - ", dashboard));
      assert.doesNotMatch(dashboardStep, /\bif:|continue-on-error|\|\|/);
    }
    // Do not fix a cold cache failure by giving the test process a network
    // fallback or by making the dependency-preparation failure non-fatal.
    const preparationStep = job.slice(job.lastIndexOf("      - ", prepare), job.indexOf("\n      - ", prepare));
    assert.doesNotMatch(preparationStep, /continue-on-error|\|\|\s*true/);
  }
}

test("all full application and cognitive Runtime jobs explicitly prepare a private locked cache", () => {
  verify(workflow);
});

for (const name of jobs) {
  test(`${name}: removing preparation or moving it after consumers is rejected`, () => {
    const job = jobSource(workflow, name);
    assert.throws(() => verify(workflow.replace(job, job.replace(preparation, "echo missing"))), /prepare/);
    assert.throws(() => verify(workflow.replace(job, job.replace(cache, "echo missing"))), /cache setup missing/);
    assert.throws(() => verify(workflow.replace(job, job.replace(preparation, "echo too-late") + `\n        run: ${preparation}\n`)), /before independent consumers/);
  });
}

for (const name of ["web-node", "storage-postgres", "desktop"]) {
  test(`${name}: missing cross-surface dependencies cannot reach the full Node inventory`, () => {
    const job = jobSource(workflow, name);
    assert.throws(() => verify(workflow.replace(job, job.replace("npm ci --prefix ../dashboard", "echo omitted"))), /Dashboard component dependencies/);
  });
}
