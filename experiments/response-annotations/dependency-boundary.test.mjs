import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const experimentDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = resolve(experimentDirectory, '../..');

function codexPatches(directory) {
  const manifest = readFileSync(resolve(directory, 'Cargo.toml'), 'utf8');
  const section = manifest.split('[patch."https://github.com/openai/codex"]')[1]?.split(/^\[/m)[0];
  assert.ok(section, 'the independent workspace must carry the audited Codex patches');
  const patches = new Map();
  for (const match of section.matchAll(/^([\w-]+)\s*=\s*\{\s*path\s*=\s*"([^"]+)"\s*\}/gm)) {
    patches.set(match[1], realpathSync(resolve(directory, match[2])));
  }
  return [...patches].sort(([left], [right]) => left.localeCompare(right));
}

test('the independent workspace preserves the production Codex dependency boundary', () => {
  assert.deepEqual(codexPatches(experimentDirectory), codexPatches(repositoryDirectory));
});

test('the checked-in lock resolves protocol adapters without the unused DNS implementation', () => {
  const lock = readFileSync(resolve(experimentDirectory, 'Cargo.lock'), 'utf8');
  const packages = lock.split('[[package]]').slice(1);
  for (const name of ['codex-network-proxy', 'codex-otel', 'codex-utils-absolute-path', 'codex-utils-pty']) {
    const matches = packages.filter((entry) => entry.match(/^name = "([^"]+)"/m)?.[1] === name);
    assert.equal(matches.length, 1, `${name} must have exactly one selected adapter`);
    assert.ok(!/^source = /m.test(matches[0]), `${name} must resolve to the audited local adapter`);
  }
  for (const name of ['hickory-proto', 'hickory-resolver', 'hickory-net', 'rama-dns']) {
    assert.ok(!packages.some((entry) => entry.match(/^name = "([^"]+)"/m)?.[1] === name),
      `unused DNS dependency ${name} must not return via unpatched Codex crates`);
  }
});
