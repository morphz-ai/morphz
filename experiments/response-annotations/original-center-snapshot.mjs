// Read-only preservation evidence for the designated original center. Snapshot
// uses SQLite online backups; comparison prints counts, never row contents.
import { DatabaseSync, backup } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, cpSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';

const [mode, root, destination] = process.argv.slice(2);
if (!['snapshot', 'compare'].includes(mode) || !isAbsolute(root ?? '') || !isAbsolute(destination ?? '')) throw new Error('mode and explicit absolute paths required');
const files = [
  'runtime/runtime.sqlite', 'center/workspace.sqlite', 'center/platform.sqlite',
  'center/browser.sqlite', 'center/objects.sqlite', 'center/script-studio.sqlite',
  'center/reader.sqlite', 'center/message-attachments/manifest.sqlite',
  'center/objects-images/manifest.sqlite', 'center/profile-avatars/manifest.sqlite',
  'center/reader-originals/manifest.sqlite', 'center/ui-packages/manifest.sqlite',
];
const digest = (value) => createHash('sha256').update(value).digest('hex');
const quote = (name) => '"' + name.replaceAll('"', '""') + '"';
const serialize = (row) => JSON.stringify(row, (_, value) => typeof value === 'bigint' ? value.toString() : value instanceof Uint8Array ? { bytes: value.length, sha256: digest(value) } : value);
function tables(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('BEGIN');
    const result = {};
    for (const { name } of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
      const statement = db.prepare(`SELECT * FROM ${quote(name)}`);
      statement.setReadBigInts(true);
      const rows = statement.all().map(serialize).sort();
      result[name] = { count: rows.length, sha256: digest(rows.join('\n')) };
    }
    db.exec('ROLLBACK');
    return result;
  } finally { db.close(); }
}
if (mode === 'snapshot') {
  const before = {};
  for (const file of files) {
    const source = join(root, file), target = join(destination, file);
    if (!existsSync(source)) throw new Error('Expected original database is absent');
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    if (existsSync(target)) throw new Error('Refusing to overwrite snapshot');
    const db = new DatabaseSync(source, { readOnly: true });
    try { await backup(db, target); } finally { db.close(); }
    chmodSync(target, 0o600);
    before[file] = tables(target);
  }
  for (const file of ['runtime/morphz.toml', 'runtime/models.toml', 'center/runtime.json', 'center/host-tools-desktop.json', 'center/application-instances.json']) {
    if (existsSync(join(root, file))) {
      const target = join(destination, 'configuration', file);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      cpSync(join(root, file), target, { errorOnExist: true, force: false });
      chmodSync(target, 0o600);
    }
  }
  writeFileSync(join(destination, 'before-state.json'), JSON.stringify(before, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ backup: destination, databases: files.length, tables: Object.values(before).reduce((n, t) => n + Object.keys(t).length, 0) }));
} else {
  const before = JSON.parse(readFileSync(join(destination, 'before-state.json'), 'utf8'));
  let unchanged = 0, total = 0;
  const differences = [];
  for (const file of files) {
    const after = tables(join(root, file));
    for (const [name, prior] of Object.entries(before[file])) {
      total++;
      if (JSON.stringify(prior) === JSON.stringify(after[name])) unchanged++;
      else differences.push({ database: file, table: name, beforeCount: prior.count, afterCount: after[name]?.count });
    }
  }
  const result = { total, unchanged, differences };
  writeFileSync(join(destination, 'after-comparison.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(result));
}
