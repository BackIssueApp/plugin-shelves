// The facet index follows the catalog (titles added, removed, or a type change
// mark it stale), keeps mature titles from accounts that may not see them, and
// the on/off setting really switches the browser and the Library filters off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PLUGINS_DIR = 'nonexistent-' + Date.now(); // keep other plugins out
process.env.METADATA_BASE_OVERRIDE = 'http://127.0.0.1:9/api';

const setup = async () => {
  const { openDb } = await import('../../../src/db.js');
  const config = (await import('../../../src/config.js')).default;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelves-'));
  config.dbPath = path.join(dir, 'cat.db');
  const db = openDb(config.dbPath);
  (await import('../../../src/users.js')).initUserTables(db); // built-in roles, as the server does at boot
  const lib = (name, type) => Number(db.prepare('INSERT INTO libraries (name, type, root_folder, sort_order) VALUES (?, ?, ?, 0)').run(name, type, dir).lastInsertRowid);
  const books = lib('Books', 'ebook');
  const audio = lib('Audiobooks', 'audiobook');
  const add = (title, author, libraryId, type, restricted = 0) => {
    const s = Number(db.prepare('INSERT INTO series (title, url, type, library_id, publisher, year, restricted) VALUES (?, ?, ?, ?, ?, 1965, ?)')
      .run(title, 'local:' + title, type, libraryId, author, restricted).lastInsertRowid);
    db.prepare('INSERT INTO issues (series_id, title, url) VALUES (?, ?, ?)').run(s, title, 'local:i:' + title);
    return s;
  };
  return { db, config, books, audio, add };
};

test('the index goes stale when titles are added or removed, or the types change', async () => {
  const { db, config, books, audio, add } = await setup();
  const { openShelvesStore } = await import('../store.js');
  const store = openShelvesStore(config.dbPath);
  add('Dune', 'Frank Herbert', books, 'ebook');
  add('Emma', 'Jane Austen', audio, 'audiobook');
  assert.equal(store.isStale(['ebook', 'audiobook']), true, 'never built');

  await store.rebuild({ types: ['ebook', 'audiobook'] });
  assert.equal(store.size(), 2);
  assert.equal(store.isStale(['ebook', 'audiobook']), false, 'fresh after a rebuild');

  const added = add('Persuasion', 'Jane Austen', books, 'ebook');
  assert.equal(store.isStale(['ebook', 'audiobook']), true, 'a new title');
  await store.rebuild({ types: ['ebook', 'audiobook'] });

  db.prepare('DELETE FROM issues WHERE series_id=?').run(added);
  db.prepare('DELETE FROM series WHERE id=?').run(added);
  assert.equal(store.isStale(['ebook', 'audiobook']), true, 'a removed title');
  await store.rebuild({ types: ['ebook', 'audiobook'] });

  assert.equal(store.isStale(['ebook']), true, 'audiobooks indexed but no longer wanted');
  await store.rebuild({ types: ['ebook'] });
  assert.equal(store.isStale(['ebook']), false);
  assert.equal(store.size('audiobook'), 0);
  store.close();
});

test('routes: mature titles follow the role and the account switch; the setting turns Shelves off', async () => {
  const { config, books, add } = await setup();
  add('Dune', 'Frank Herbert', books, 'ebook');
  add('Secret Diary', 'Anon Writer', books, 'ebook', 1);
  const { pluginApi, registeredRoutes, registeredCollectionFilters } = await import('../../../src/plugins.js');
  (await import('../index.js')).default(pluginApi);
  const route = (p) => registeredRoutes().find((r) => r.method === 'get' && r.path === p).handler;
  const call = (p, user, query = {}) => new Promise((resolve) => route(p)({ user, query }, { json: resolve, status() { return this; } }));

  await (await import('../store.js')).openShelvesStore(config.dbPath).rebuild({ types: ['ebook', 'audiobook'] });
  const admin = { id: 1, role: 'admin', hide_mature: 0 };
  const optedOut = { id: 2, role: 'admin', hide_mature: 1 };
  const viewer = { id: 3, role: 'viewer', hide_mature: 0 };

  const titles = async (user) => (await call('/api/shelves/items', user)).items.map((i) => i.title).sort();
  assert.deepEqual(await titles(admin), ['Dune', 'Secret Diary'], 'an admin sees mature titles');
  assert.deepEqual(await titles(optedOut), ['Dune'], 'unless their account hides them');
  assert.deepEqual(await titles(viewer), ['Dune'], 'a viewer never does');
  const names = async (user) => (await call('/api/shelves/authors', user)).authors.map((a) => a.name);
  assert.deepEqual(await names(viewer), ['Frank Herbert'], 'the A–Z author list hides them too');
  assert.equal((await names(admin)).length, 2);

  const filter = registeredCollectionFilters().find((f) => f.id === 'shelves');
  assert.ok(Array.isArray(filter.resolve({ decades: [1960] }, { userId: 1 })));
  config.shelvesEnabled = false;
  try {
    assert.equal((await call('/api/shelves/status', admin)).enabled, false);
    assert.equal((await call('/api/shelves/facets', admin)).disabled, true);
    assert.deepEqual((await call('/api/shelves/items', admin)).items, []);
    assert.equal(filter.resolve({ decades: [1960] }, { userId: 1 }), null, 'the Library filters stop narrowing');
  } finally { config.shelvesEnabled = true; }
});
