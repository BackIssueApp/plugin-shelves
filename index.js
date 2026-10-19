// Shelves — a faceted browser for large book/audiobook libraries. The sidebar
// entry opens a full-screen drawer the plugin renders itself (the same pattern
// other plugins use), and the same facets feed core's Library Filters modal. It
// reads a plugin-owned facet index (store.js) built from the core catalog, and
// every result links to the normal core series page. Browsing is
// `library.view`; rebuilding the index is `library.manage`.
import config from '../../src/config.js';
import { roleGrants, CORE_PERMISSIONS } from '../../src/users.js';
import { registeredPermissions } from '../../src/plugins.js';
import { openShelvesStore, DEFAULT_TYPES } from './store.js';

const csv = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const csvNums = (s) => csv(s).map(Number).filter(Number.isFinite);
// The library types the index knows how to describe (authors, formats, status).
const KNOWN_TYPES = new Set(DEFAULT_TYPES);
const STALE_CHECK_MS = 10 * 60_000;

export default function register(api) {
  const store = openShelvesStore(config.dbPath);
  const CAN_VIEW = 'library.view';
  const CAN_MANAGE = 'library.manage';

  // Mirror core's rule: may this request see mature/restricted series? The role
  // must grant library.restricted and the account must not have opted out with
  // its own "hide mature" switch. Open mode (id 0) is the local admin.
  const permCatalog = () => new Map([...CORE_PERMISSIONS, ...registeredPermissions()].map((p) => [p.key, p]));
  const canRestricted = (req) => {
    const u = req.user;
    if (!u) return false;
    if (u.id === 0) return true;
    try { return roleGrants(store.db, u.role, 'library.restricted', permCatalog()) && !u.hide_mature; } catch { return false; }
  };

  config.shelvesEnabled ??= true;
  config.shelvesTypes ??= DEFAULT_TYPES.join(',');
  const enabled = () => config.shelvesEnabled !== false && config.shelvesEnabled !== 'false';
  const cfgTypes = () => { const t = csv(config.shelvesTypes).filter((x) => KNOWN_TYPES.has(x)); return t.length ? t : DEFAULT_TYPES; };

  api.registerSettings?.({ shelvesEnabled: { type: 'bool' }, shelvesTypes: {} });
  api.registerClientAsset?.({ js: 'client/ui.js', css: 'client/shelves.css' });

  const rebuildLogged = () => store.rebuild({ types: cfgTypes() })
    .then((st) => { if (st?.error) console.warn('[shelves] rebuild failed:', st.error); return st; });
  // A nightly rebuild picks up changes the staleness check can't see (a book
  // that gained a file, an edited author). A Jobs page edit persists and wins.
  config.shelvesRebuildCron ??= '30 4 * * *';
  config.shelvesRebuildEnabled ??= true;
  api.registerJob?.({ id: 'shelves-rebuild', label: 'Rebuild the browse index', scheduleKey: 'shelvesRebuildHours', run: () => (enabled() ? rebuildLogged() : null) });
  // Keep the index in step with the catalog: shortly after startup, then every
  // few minutes, rebuild when titles of the indexed types were added or removed
  // (a scan, an import, a deleted library) or the type list changed.
  //
  // Not while a remote catalog sync is running, though: it adds titles all
  // the time, so every check would find the index stale and start another
  // full rebuild. The sync's end is the next check's cue. (Soft dependency on
  // the ebooks/audiobooks plugins — absent, nothing to wait for.)
  const syncRunning = [];
  for (const mod of ['../ebooks/remotesync.js', '../audiobooks/remotesync.js']) {
    import(mod).then((m) => { if (typeof m.isRemoteSyncRunning === 'function') syncRunning.push(m.isRemoteSyncRunning); }).catch(() => {});
  }
  const remoteSyncBusy = () => syncRunning.some((f) => { try { return f(); } catch { return false; } });
  let checkedTypes = '';
  const refreshIfStale = () => {
    try {
      if (!enabled() || store.rebuildState().running || remoteSyncBusy()) return;
      checkedTypes = cfgTypes().join(',');
      if (store.isStale(cfgTypes())) rebuildLogged();
    } catch { /* fresh install: core tables not there yet */ }
  };
  setTimeout(refreshIfStale, 20_000).unref?.();
  setInterval(refreshIfStale, STALE_CHECK_MS).unref?.();

  const parseSel = (req) => ({
    type: req.query.type || null,
    libraryId: Number(req.query.library) || null,
    authorIds: csvNums(req.query.authors),
    decades: csvNums(req.query.decades),
    formats: csv(req.query.formats),
    status: req.query.status || null,
    search: req.query.q || null,
    includeRestricted: canRestricted(req),
  });
  const uid = (req) => (req.user && req.user.id) || 0;
  const OFF = { disabled: true };

  // Is Shelves on, which types does it cover, and is the index built? The
  // client reads this at boot to decide on the sidebar entry and filters.
  api.registerRoute('get', '/api/shelves/status', (_req, res) => {
    // A changed type list (Settings → Plugins) starts its rebuild on the next
    // page load rather than waiting for the timer.
    if (cfgTypes().join(',') !== checkedTypes) refreshIfStale();
    res.json({ enabled: enabled(), types: cfgTypes(), size: store.size(), rebuild: store.rebuildState() });
  }, { access: CAN_VIEW });

  // Facet computation scans the whole shelf index several times (~0.5-1s at
  // 300k+ rows, synchronously) — cache per user+selection briefly so opening
  // the Filters modal twice doesn't recompute, and repeat opens are instant.
  // A finished rebuild bumps the generation, which retires every cached entry.
  const facetsCache = new Map(); // key → { at, data, refreshing }
  const FACETS_TTL_MS = 5 * 60_000;
  api.registerRoute('get', '/api/shelves/facets', (req, res) => {
    if (!enabled()) return res.json(OFF);
    const sel = parseSel(req);
    const authorSearch = req.query.authorq || null;
    const userId = uid(req);
    const key = JSON.stringify([store.rebuildState().generation, userId, sel, authorSearch]);
    const hit = facetsCache.get(key);
    if (hit) {
      // Stale-while-revalidate: serve instantly at any age; refresh off the
      // request path when stale. Facet counts drift only on scans/progress,
      // so brief staleness is invisible.
      if (Date.now() - hit.at >= FACETS_TTL_MS && !hit.refreshing) {
        hit.refreshing = true;
        setImmediate(() => {
          try { facetsCache.set(key, { at: Date.now(), data: store.facets(userId, sel, { authorSearch }) }); }
          catch { hit.refreshing = false; }
        });
      }
      return res.json(hit.data);
    }
    const data = store.facets(userId, sel, { authorSearch });
    if (facetsCache.size > 100) facetsCache.clear();
    facetsCache.set(key, { at: Date.now(), data });
    res.json(data);
  }, { access: CAN_VIEW });

  // Resolve the core Library Filters selection → matching series ids, so core's
  // real grid is narrowed (no plugin-rendered grid). Empty selection → null.
  api.registerCollectionFilter?.({
    id: 'shelves',
    resolve(selection, ctx) {
      if (!enabled()) return null;
      const s = selection || {};
      const authorIds = (s.authors || []).map(Number).filter(Number.isFinite);
      const decades = (s.decades || []).map(Number).filter(Number.isFinite);
      const formats = (s.formats || []).filter(Boolean);
      const status = s.status || null;
      if (!authorIds.length && !decades.length && !formats.length && !status) return null;
      return store.matchingIds(ctx.userId || 0, {
        authorIds, decades, formats, status,
        libraryId: ctx.library || null, includeRestricted: ctx.includeRestricted !== false,
      });
    },
  });

  api.registerRoute('get', '/api/shelves/items', (req, res) => {
    if (!enabled()) return res.json({ ...OFF, items: [] });
    const page = Math.max(0, Number(req.query.page) || 0);
    const limit = Math.max(1, Math.min(120, Number(req.query.limit) || 60));
    const sort = String(req.query.sort || 'author');
    res.json({ items: store.items(uid(req), parseSel(req), { sort, limit, offset: page * limit }), page, limit });
  }, { access: CAN_VIEW });

  api.registerRoute('get', '/api/shelves/authors', (req, res) => {
    if (!enabled()) return res.json({ ...OFF, letters: [], authors: [] });
    res.json(store.authorsIndex({
      type: req.query.type || null,
      library: Number(req.query.library) || null,
      letter: req.query.letter || null,
      search: req.query.q || null,
      includeRestricted: canRestricted(req),
    }));
  }, { access: CAN_VIEW });

  // Rebuild the index (curation).
  api.registerRoute('post', '/api/shelves/rebuild', (_req, res) => {
    if (store.rebuildState().running) return res.status(409).json({ error: 'A rebuild is already running.', state: store.rebuildState() });
    setTimeout(rebuildLogged, 0);
    res.json({ started: true, state: store.rebuildState() });
  }, { access: CAN_MANAGE });
  api.registerRoute('get', '/api/shelves/rebuild/status', (_req, res) => res.json(store.rebuildState()), { access: CAN_VIEW });
}
