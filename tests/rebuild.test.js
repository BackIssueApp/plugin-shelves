// A rebuild fills copies of the index tables and swaps them in at the end, so
// the facets keep answering from the complete old index while it runs; the
// per-library filter has its own index; leftovers of an interrupted rebuild
// are cleared on open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../../src/db.js';
import { openShelvesStore } from '../store.js';

function setup(n = 25) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelves-rebuild-'));
  const dbPath = path.join(dir, 'cat.db');
  const db = openDb(dbPath);
  const lib = Number(db.prepare("INSERT INTO libraries (name, type, root_folder, sort_order) VALUES ('Books', 'ebook', ?, 0)").run(dir).lastInsertRowid);
  const lib2 = Number(db.prepare("INSERT INTO libraries (name, type, root_folder, sort_order) VALUES ('More', 'ebook', ?, 1)").run(dir).lastInsertRowid);
  const add = (title, author, library = lib) => {
    const s = Number(db.prepare("INSERT INTO series (title, url, type, library_id, publisher, year) VALUES (?, ?, 'ebook', ?, ?, 1990)")
      .run(title, 'local:' + title, library, author).lastInsertRowid);
    db.prepare('INSERT INTO issues (series_id, title, url) VALUES (?, ?, ?)').run(s, title, 'local:i:' + title);
    return s;
  };
  for (let k = 0; k < n; k++) add(`Book ${k}`, `Author ${k % 5}`, k % 2 ? lib : lib2);
  return { dir, dbPath, db, lib, lib2, add };
}

test('facets answer from the whole old index while a rebuild runs, then from the new one', async () => {
  const { dbPath, add } = setup();
  const store = openShelvesStore(dbPath);
  await store.rebuild({ chunk: 5 });
  assert.equal(store.size(), 25);
  add('Fresh Book', 'Author 9');
  const seen = [];
  const running = store.rebuild({ chunk: 5 });
  while (store.rebuildState().running) {
    seen.push(store.size());
    seen.push(store.facets(0, { includeRestricted: true }).total);
    await new Promise((r) => setImmediate(r));
  }
  await running;
  assert.ok(seen.length > 4, 'sampled mid-rebuild');
  assert.ok(seen.every((n) => n === 25), `never a partial index: ${[...new Set(seen)]}`);
  assert.equal(store.size(), 26);
  assert.equal(store.authorsIndex({ includeRestricted: true }).authors.length, 6);
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'shelf_%'").all().map((r) => r.name).sort();
  assert.deepEqual(tables, ['shelf_authors', 'shelf_index', 'shelf_series_authors']);
  // The swapped-in tables carry every secondary index, and a reopen adds no duplicates.
  const cols = (d, t) => d.prepare('SELECT name FROM pragma_index_list(?)').all(t)
    .map((r) => d.prepare('SELECT group_concat(name) c FROM pragma_index_info(?)').get(r.name).c).sort();
  assert.deepEqual(cols(store.db, 'shelf_index'), ['decade', 'library_id', 'sort_author', 'sort_title', 'type']);
  store.close();
  const again = openShelvesStore(dbPath);
  assert.equal(cols(again.db, 'shelf_index').length, 5);
  assert.equal(again.size(), 26);
  again.close();
});

test('per-library filters use the library index and match the right series', async () => {
  const { dbPath, lib } = setup();
  const store = openShelvesStore(dbPath);
  await store.rebuild();
  const ids = store.matchingIds(0, { decades: [1990], libraryId: lib });
  assert.equal(ids.length, 12);
  const plan = store.db.prepare('EXPLAIN QUERY PLAN SELECT series_id FROM shelf_index si WHERE si.library_id = ?').all(lib).map((r) => r.detail).join(' ');
  assert.match(plan, /library_id/);
  store.close();
});

test('an interrupted rebuild leaves nothing behind after a reopen; a failed one keeps the live index', async () => {
  const { dbPath } = setup(4);
  const store = openShelvesStore(dbPath);
  await store.rebuild();
  store.db.exec('CREATE TABLE shelf_index_next (x)');
  store.close();
  const again = openShelvesStore(dbPath);
  assert.equal(again.db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name LIKE 'shelf_%_next'").get().c, 0);
  // A rebuild that fails part-way: the live tables are untouched.
  const orig = again.db.transaction.bind(again.db);
  let calls = 0;
  again.db.transaction = (fn) => { if (++calls === 2) throw new Error('disk full'); return orig(fn); };
  const st = await again.rebuild({ chunk: 2 });
  again.db.transaction = orig;
  assert.match(st.error, /disk full/);
  assert.equal(again.size(), 4);
  assert.equal(again.db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name LIKE 'shelf_%_next'").get().c, 0);
  again.close();
});
