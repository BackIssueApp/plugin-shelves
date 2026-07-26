// Shelves — a faceted browser for large book/audiobook libraries, rendered
// entirely by the plugin (sidebar entry → full-screen drawer, the same pattern
// other plugins use) so it needs no core UI change. It reads a plugin-owned
// facet index (store.js) built from the core catalog, and every result links to
// the normal core series page. Browsing is `library.view`; rebuilding the index
// is `library.manage`.
import config from '../../src/config.js';
import { openShelvesStore, DEFAULT_TYPES } from './store.js';

const csv = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const csvNums = (s) => csv(s).map(Number).filter(Number.isFinite);

// Mirror core's rule: may this request see mature/restricted series? req.user
// carries the resolved permission list + the per-user hideMature flag; open mode
// (id 0) is the local admin and sees everything.
function canRestricted(req) {
  const u = req.user;
  if (!u) return false;
  if (u.id === 0) return true;
  const perms = u.permissions || [];
  return (perms.includes('*') || perms.includes('library.restricted')) && !u.hideMature;
}

export default function register(api) {
  const store = openShelvesStore(config.dbPath);
  const CAN_VIEW = 'library.view';
  const CAN_MANAGE = 'library.manage';

  config.shelvesEnabled ??= true;
  config.shelvesTypes ??= DEFAULT_TYPES.join(',');
  const cfgTypes = () => { const t = csv(config.shelvesTypes); return t.length ? t : DEFAULT_TYPES; };

  api.registerSettings?.({ shelvesEnabled: { type: 'bool' }, shelvesTypes: {} });
  api.registerClientAsset?.({ js: 'client/ui.js' });

  const runRebuild = () => store.rebuild({ types: cfgTypes() });
  api.registerJob?.({ id: 'shelves-rebuild', label: 'Rebuild the browse index', scheduleKey: 'shelvesRebuildHours', run: () => runRebuild() });
  // Boot catch-up: build the index shortly after startup if it's empty but there
  // are libraries of the configured types to browse.
  setTimeout(() => {
    try {
      if (store.size()) return;
      const ph = cfgTypes().map(() => '?').join(',');
      const n = store.db.prepare(`SELECT COUNT(*) c FROM series WHERE type IN (${ph}) AND library_id IS NOT NULL`).get(...cfgTypes()).c;
      if (n > 0) runRebuild();
    } catch { /* fresh install */ }
  }, 20_000).unref?.();

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

  // Is the index built + what types does it cover? (client shows a build prompt
  // when empty).
  api.registerRoute('get', '/api/shelves/status', (req, res) => {
    res.json({ enabled: config.shelvesEnabled !== false, types: cfgTypes(), size: store.size(), rebuild: store.rebuildState() });
  }, { access: CAN_VIEW });

  // Facet computation scans the whole shelf index several times (~0.5-1s at
  // 300k+ rows, synchronously) — cache per user+selection briefly so opening
  // the Filters modal twice doesn't recompute, and repeat opens are instant.
  const facetsCache = new Map(); // key → { at, data, refreshing }
  const FACETS_TTL_MS = 5 * 60_000;
  api.registerRoute('get', '/api/shelves/facets', (req, res) => {
    const sel = parseSel(req);
    const authorSearch = req.query.authorq || null;
    const userId = uid(req);
    const key = JSON.stringify([userId, sel, authorSearch]);
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
    const page = Math.max(0, Number(req.query.page) || 0);
    const limit = Math.max(1, Math.min(120, Number(req.query.limit) || 60));
    const sort = String(req.query.sort || 'author');
    res.json({ items: store.items(uid(req), parseSel(req), { sort, limit, offset: page * limit }), page, limit });
  }, { access: CAN_VIEW });

  api.registerRoute('get', '/api/shelves/authors', (req, res) => {
    res.json(store.authorsIndex({
      type: req.query.type || null,
      library: Number(req.query.library) || null,
      letter: req.query.letter || null,
      search: req.query.q || null,
    }));
  }, { access: CAN_VIEW });

  // Rebuild the index (curation).
  api.registerRoute('post', '/api/shelves/rebuild', (_req, res) => {
    if (store.rebuildState().running) return res.status(409).json({ error: 'A rebuild is already running.', state: store.rebuildState() });
    setTimeout(() => { try { runRebuild(); } catch (e) { console.warn('[shelves] rebuild failed:', e?.message || e); } }, 0);
    res.json({ started: true, state: store.rebuildState() });
  }, { access: CAN_MANAGE });
  api.registerRoute('get', '/api/shelves/rebuild/status', (_req, res) => res.json(store.rebuildState()), { access: CAN_VIEW });
}
