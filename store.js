// Shelves facet index. A big book/audiobook library is unbrowsable as one flat
// list, so this builds a denormalized, indexed view of the core catalog that
// faceted queries (author / decade / format / reading-status) run against fast
// at 100k+ scale. Everything here is derived from CORE tables (series, issues,
// library_files) plus the reading-progress tables the ebooks/audiobooks plugins
// own — no core schema change. The index is rebuilt on demand (and on a
// schedule); it is a cache, so a stale entry only means "rebuild to refresh".
import Database from 'better-sqlite3';

export const DEFAULT_TYPES = ['ebook', 'audiobook'];

const lower = (s) => String(s || '').toLowerCase();
// Sort key for a title: lowercased, leading article dropped ("The Hobbit" → "hobbit").
const sortTitle = (t) => lower(t).replace(/^(the|a|an)\s+/i, '').trim();
// Sort key for an author: "Frank Herbert" → "herbert, frank" (surname first) when
// it's a plain two+-word name with no comma; otherwise as written. Heuristic, but
// stable and good enough for an A–Z index.
function sortAuthor(name) {
  const n = String(name || '').trim();
  if (!n || n.includes(',')) return lower(n);
  const parts = n.split(/\s+/);
  if (parts.length < 2) return lower(n);
  const last = parts[parts.length - 1];
  return lower(`${last}, ${parts.slice(0, -1).join(' ')}`);
}
const letterOf = (sortName) => {
  const c = String(sortName || '').charAt(0).toUpperCase();
  return c >= 'A' && c <= 'Z' ? c : '#';
};
const splitAuthors = (publisher) => String(publisher || '').split(/[,;]| and | & /i).map((a) => a.trim()).filter(Boolean);
const year4 = (s) => { const m = String(s || '').match(/(\d{4})/); return m ? Number(m[1]) : null; };

export function openShelvesStore(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  // The three index tables and their secondary indexes. A rebuild fills
  // `<table>_next` copies and swaps them in (see rebuild), so the definitions
  // live here once. Secondary indexes are matched by column rather than name:
  // a swapped-in table brings its own, under the names it was built with.
  const TABLES = {
    shelf_index: `(
      series_id   INTEGER PRIMARY KEY,
      type        TEXT NOT NULL,
      issue_id    INTEGER,            -- representative issue (for status/format)
      title       TEXT,
      sort_title  TEXT,
      sort_author TEXT,               -- primary author's sort key
      year        INTEGER,
      decade      INTEGER,
      format      TEXT,               -- 'epub' | 'pdf' | 'audiobook' | 'on-demand' | …
      cover_url   TEXT,
      restricted  INTEGER NOT NULL DEFAULT 0,
      library_id  INTEGER
    )`,
    shelf_authors: `(
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      name      TEXT NOT NULL UNIQUE,
      sort_name TEXT NOT NULL,
      letter    TEXT NOT NULL
    )`,
    shelf_series_authors: `(
      series_id INTEGER NOT NULL,
      author_id INTEGER NOT NULL,
      PRIMARY KEY (series_id, author_id)
    )`,
  };
  // library_id: every per-library facet and filter (the mobile home's
  // Continue listening among them) narrows by it.
  const INDEXES = {
    shelf_index: ['type', 'sort_author', 'decade', 'sort_title', 'library_id'],
    shelf_authors: ['sort_name', 'letter'],
    shelf_series_authors: ['author_id'],
  };
  /** Create any of `base`'s secondary indexes that `table` lacks. */
  const ensureIndexes = (table, base = table) => {
    const have = new Set(db.prepare('SELECT name FROM pragma_index_list(?)').all(table)
      .map((r) => db.prepare('SELECT group_concat(name) c FROM pragma_index_info(?)').get(r.name).c));
    const tag = Date.now().toString(36);
    for (const col of INDEXES[base]) {
      if (!have.has(col)) db.exec(`CREATE INDEX "idx_${base}_${col}_${tag}" ON ${table}(${col})`);
    }
  };
  for (const [t, def] of Object.entries(TABLES)) {
    db.exec(`CREATE TABLE IF NOT EXISTS ${t} ${def}`);
    ensureIndexes(t);
  }
  // A rebuild interrupted by a restart leaves its half-filled copies behind.
  for (const t of Object.keys(TABLES)) db.exec(`DROP TABLE IF EXISTS ${t}_next`);

  // The reading-progress tables belong to the ebooks/audiobooks plugins and may
  // be absent (plugin not installed). Detect once so status queries only union
  // the sources that exist.
  const hasTable = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  const progressSources = [];
  if (hasTable('ebooks_progress')) {
    progressSources.push("SELECT issue_id, CASE WHEN fraction>=0.99 THEN 'finished' WHEN fraction>0 THEN 'reading' ELSE 'unread' END st FROM ebooks_progress WHERE user_id=@uid");
  }
  if (hasTable('audiobooks_progress')) {
    progressSources.push("SELECT issue_id, CASE WHEN finished=1 OR (duration>0 AND position>=duration-MIN(MAX(120,duration*0.01),duration*0.1)) THEN 'finished' WHEN position>0 THEN 'reading' ELSE 'unread' END st FROM audiobooks_progress WHERE user_id=@uid");
  }
  // A CTE mapping the user's issues → 'reading'/'finished' (absent = 'unread').
  const progressCte = progressSources.length
    ? `prog AS (${progressSources.join(' UNION ALL ')})`
    : `prog AS (SELECT NULL issue_id, NULL st WHERE 0)`;

  const rebuildState = { running: false, done: 0, total: 0, finishedAt: null, error: null, generation: 0 };

  const api = {
    db,
    rebuildState: () => ({ ...rebuildState }),

    /** Rebuild the whole facet index from the core catalog. Chunked + yielding
     *  (better-sqlite3 is synchronous, so a single 100k-row transaction would
     *  stall the event loop for seconds): the rows go into `_next` copies of
     *  the tables, a chunk per transaction with a yield between, and the
     *  copies replace the live tables in one short transaction at the end —
     *  so facets keep answering from the complete old index the whole time,
     *  instead of from a half-emptied one. Async; returns the final tallies. */
    async rebuild({ types = DEFAULT_TYPES, chunk = 2000 } = {}) {
      if (rebuildState.running) return rebuildState;
      Object.assign(rebuildState, { running: true, done: 0, total: 0, finishedAt: null, error: null });
      try {
        const t = (types.length ? types : DEFAULT_TYPES).map(String);
        const ph = t.map(() => '?').join(',');
        const breathe = () => new Promise((r) => setImmediate(r)); // let the event loop breathe
        // The series rows are read a chunk at a time inside the loop below
        // (the table is wide — book descriptions — and reading it whole was
        // most of a second in one go).
        rebuildState.total = db.prepare(`SELECT COUNT(*) c FROM series WHERE type IN (${ph}) AND library_id IS NOT NULL`).get(...t).c;
        await breathe();
        // Prefetch the two lookups the loop needs as maps (ONE scan each) rather
        // than two point-queries per series — at 140k series the per-row form is
        // effectively O(n²) and takes minutes. Representative issue = the lowest
        // issue id per series; format = the extension of that issue's first valid
        // file (most on-demand books have none → 'on-demand').
        const firstIssue = new Map();
        for (const r of db.prepare('SELECT series_id, MIN(id) iid FROM issues GROUP BY series_id').iterate()) firstIssue.set(r.series_id, r.iid);
        await breathe();
        const fileExt = new Map();
        for (const r of db.prepare("SELECT issue_id, path FROM library_files WHERE valid=1 AND issue_id IS NOT NULL").iterate()) {
          if (!fileExt.has(r.issue_id)) { const ext = String(r.path || '').split('.').pop().toLowerCase(); fileExt.set(r.issue_id, ext); }
        }
        await breathe();
        for (const [tb, def] of Object.entries(TABLES)) db.exec(`DROP TABLE IF EXISTS ${tb}_next; CREATE TABLE ${tb}_next ${def}`);
        const authorId = db.prepare('SELECT id FROM shelf_authors_next WHERE name=?');
        const insAuthor = db.prepare('INSERT INTO shelf_authors_next (name, sort_name, letter) VALUES (?,?,?)');
        const insIndex = db.prepare(`INSERT INTO shelf_index_next
          (series_id, type, issue_id, title, sort_title, sort_author, year, decade, format, cover_url, restricted, library_id)
          VALUES (@sid,@type,@iid,@title,@stitle,@sauthor,@year,@decade,@format,@cover,@restricted,@lib)`);
        const insLink = db.prepare('INSERT OR IGNORE INTO shelf_series_authors_next (series_id, author_id) VALUES (?,?)');
        const authorCache = new Map();
        const ensureAuthor = (name) => {
          if (authorCache.has(name)) return authorCache.get(name);
          let row = authorId.get(name);
          if (!row) { const sn = sortAuthor(name); const id = insAuthor.run(name, sn, letterOf(sn)).lastInsertRowid; row = { id }; }
          authorCache.set(name, row.id);
          return row.id;
        };
        const indexOne = (s) => {
          const issueId = firstIssue.get(s.id) ?? null;
          const authors = splitAuthors(s.publisher);
          let format = null;
          if (s.type === 'audiobook') format = 'audiobook';
          else if (issueId) {
            const ext = fileExt.get(issueId);
            if (ext) format = ext === 'pdf' ? 'pdf' : ext === 'epub' ? 'epub' : ext;
            else format = 'on-demand';
          }
          const yr = year4(s.year);
          const y = (yr && yr >= 1450 && yr <= 2100) ? yr : null; // drop parse noise (e.g. year "1000")
          insIndex.run({
            sid: s.id, type: s.type, iid: issueId, title: s.title,
            stitle: sortTitle(s.title), sauthor: authors.length ? sortAuthor(authors[0]) : '',
            year: y, decade: y ? Math.floor(y / 10) * 10 : null, format,
            cover: s.cover_url || null, restricted: s.restricted ? 1 : 0, lib: s.library_id,
          });
          for (const a of authors) insLink.run(s.id, ensureAuthor(a));
        };
        const nextChunk = db.prepare(
          `SELECT id, title, publisher, year, type, cover_url, restricted, library_id
             FROM series WHERE id > ? AND type IN (${ph}) AND library_id IS NOT NULL ORDER BY id LIMIT ?`);
        for (let after = 0; ;) {
          const slice = nextChunk.all(after, ...t, chunk);
          if (!slice.length) break;
          after = slice[slice.length - 1].id;
          db.transaction(() => { for (const s of slice) indexOne(s); })();
          rebuildState.done += slice.length;
          await breathe();
        }
        // Secondary indexes on the filled copies (faster than maintaining them
        // row by row), one at a time, then the swap.
        for (const [tb, cols] of Object.entries(INDEXES)) {
          for (const col of cols) { db.exec(`CREATE INDEX "idx_${tb}_${col}_${Date.now().toString(36)}" ON ${tb}_next(${col})`); await breathe(); }
        }
        db.transaction(() => {
          for (const tb of Object.keys(TABLES)) db.exec(`DROP TABLE ${tb}; ALTER TABLE ${tb}_next RENAME TO ${tb}`);
        })();
        rebuildState.finishedAt = new Date().toISOString();
        rebuildState.generation++;
      } catch (e) {
        rebuildState.error = String(e?.message || e);
        // The live tables are untouched; drop the half-built copies.
        try { for (const tb of Object.keys(TABLES)) db.exec(`DROP TABLE IF EXISTS ${tb}_next`); } catch { /* next rebuild drops them */ }
      } finally {
        rebuildState.running = false;
      }
      return rebuildState;
    },

    /** Does the index disagree with the catalog for these types? Compares the
     *  count and newest id of indexable series against the index, and looks for
     *  rows of types no longer indexed. Cheap (three indexed aggregates), so it
     *  can run on a timer: titles a scan added or removed show up without
     *  waiting for the nightly rebuild. */
    isStale(types = DEFAULT_TYPES) {
      const t = (types.length ? types : DEFAULT_TYPES).map(String);
      const ph = t.map(() => '?').join(',');
      const cat = db.prepare(`SELECT COUNT(*) c, COALESCE(MAX(id),0) m FROM series WHERE type IN (${ph}) AND library_id IS NOT NULL`).get(...t);
      const idx = db.prepare(`SELECT COUNT(*) c, COALESCE(MAX(series_id),0) m FROM shelf_index WHERE type IN (${ph})`).get(...t);
      const other = db.prepare(`SELECT COUNT(*) c FROM shelf_index WHERE type NOT IN (${ph})`).get(...t).c;
      return cat.c !== idx.c || cat.m !== idx.m || other > 0;
    },

    /** Count of indexed series (0 → never built). */
    size(type) {
      return type
        ? db.prepare('SELECT COUNT(*) c FROM shelf_index WHERE type=?').get(type).c
        : db.prepare('SELECT COUNT(*) c FROM shelf_index').get().c;
    },

    // ---- Faceted querying -----------------------------------------------------
    // A selection is { type, authorIds[], decades[], formats[], status, search,
    // includeRestricted }. `whereParts` returns per-dimension SQL fragments +
    // params so callers can compose all of them (items) or all-but-one (facets).
    _whereParts(userId, sel) {
      const p = { uid: userId ?? -1 };
      const parts = {};
      parts.type = sel.type ? 'si.type = @type' : '1';
      if (sel.type) p.type = sel.type;
      if (sel.libraryId) { parts.library = 'si.library_id = @lib'; p.lib = sel.libraryId; }
      if (!sel.includeRestricted) parts.restricted = 'si.restricted = 0';
      if (sel.search) { parts.search = 'si.sort_title LIKE @q'; p.q = '%' + sortTitle(sel.search) + '%'; }
      if (sel.authorIds?.length) {
        sel.authorIds.forEach((id, i) => { p['a' + i] = id; });
        parts.author = `si.series_id IN (SELECT series_id FROM shelf_series_authors WHERE author_id IN (${sel.authorIds.map((_, i) => '@a' + i).join(',')}))`;
      }
      if (sel.decades?.length) {
        sel.decades.forEach((d, i) => { p['d' + i] = Number(d); });
        parts.decade = `si.decade IN (${sel.decades.map((_, i) => '@d' + i).join(',')})`;
      }
      if (sel.formats?.length) {
        sel.formats.forEach((f, i) => { p['f' + i] = f; });
        parts.format = `si.format IN (${sel.formats.map((_, i) => '@f' + i).join(',')})`;
      }
      if (sel.status) { parts.status = "COALESCE(pr.st,'unread') = @status"; p.status = sel.status; }
      return { parts, params: p };
    },
    // Compose a WHERE from the parts, optionally dropping one dimension (for that
    // dimension's own facet counts). Always joins prog for status.
    _sql(userId, sel, { except } = {}) {
      const { parts, params } = this._whereParts(userId, sel);
      const clauses = Object.entries(parts).filter(([k]) => k !== except).map(([, v]) => v);
      return {
        cte: `WITH ${progressCte}`,
        join: 'LEFT JOIN prog pr ON pr.issue_id = si.issue_id',
        where: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '',
        params,
      };
    },

    /** Facet groups + counts for the current selection. Each group's counts
     *  apply every OTHER selected dimension but not its own (proper facets), so
     *  you can widen within a dimension. Author list is the top `authorLimit`. */
    facets(userId, sel, { authorLimit = 60, authorSearch = null } = {}) {
      const q = (dim, col) => {
        const s = this._sql(userId, sel, { except: dim });
        return db.prepare(`${s.cte} SELECT ${col} k, COUNT(*) c FROM shelf_index si ${s.join} ${s.where} GROUP BY k`).all(s.params);
      };
      // Decades / formats / statuses.
      const decades = q('decade', 'si.decade').filter((r) => r.k != null).map((r) => ({ decade: r.k, count: r.c })).sort((a, b) => b.decade - a.decade);
      const formats = q('format', 'si.format').filter((r) => r.k != null).map((r) => ({ format: r.k, count: r.c })).sort((a, b) => b.count - a.count);
      const statusRaw = q('status', "COALESCE(pr.st,'unread')");
      const statusMap = Object.fromEntries(statusRaw.map((r) => [r.k, r.c]));
      const statuses = ['unread', 'reading', 'finished'].map((k) => ({ status: k, count: statusMap[k] || 0 })).filter((x) => x.count);
      // Authors: top-N by count within the other filters (optionally name-filtered
      // so the modal's author search can find one outside the top-N).
      const sa = this._sql(userId, sel, { except: 'author' });
      const aparams = { ...sa.params, alim: authorLimit };
      let awhere = sa.where;
      if (authorSearch) { awhere = awhere ? `${awhere} AND a.sort_name LIKE @asearch` : 'WHERE a.sort_name LIKE @asearch'; aparams.asearch = '%' + lower(authorSearch) + '%'; }
      const authors = db.prepare(`${sa.cte}
        SELECT a.id, a.name, COUNT(*) c
        FROM shelf_index si ${sa.join}
        JOIN shelf_series_authors ssa ON ssa.series_id = si.series_id
        JOIN shelf_authors a ON a.id = ssa.author_id
        ${awhere}
        GROUP BY a.id ORDER BY c DESC, a.sort_name LIMIT @alim`).all(aparams)
        .map((r) => ({ id: r.id, name: r.name, count: r.c }));
      // Total matching the full selection.
      const st = this._sql(userId, sel, {});
      const total = db.prepare(`${st.cte} SELECT COUNT(*) c FROM shelf_index si ${st.join} ${st.where}`).get(st.params).c;
      return { total, authors, decades, formats, statuses };
    },

    /** A page of series matching the selection, in the given sort order. */
    items(userId, sel, { sort = 'author', limit = 60, offset = 0 } = {}) {
      const s = this._sql(userId, sel, {});
      const ORDER = {
        author: 'ORDER BY si.sort_author, si.sort_title',
        title: 'ORDER BY si.sort_title',
        year: 'ORDER BY si.year DESC, si.sort_title',
        added: 'ORDER BY si.series_id DESC',
      };
      const cap = Math.max(1, Math.min(200, Number(limit) || 60));
      const off = Math.max(0, Number(offset) || 0);
      const rows = db.prepare(`${s.cte}
        SELECT si.series_id, si.title, si.type, si.year, si.cover_url, si.format,
               COALESCE(pr.st,'unread') status,
               (SELECT a.name FROM shelf_series_authors ssa JOIN shelf_authors a ON a.id=ssa.author_id
                  WHERE ssa.series_id=si.series_id ORDER BY a.sort_name LIMIT 1) author
        FROM shelf_index si ${s.join} ${s.where}
        ${ORDER[sort] || ORDER.author} LIMIT @lim OFFSET @off`).all({ ...s.params, lim: cap, off });
      return rows.map((r) => ({
        id: r.series_id, title: r.title, type: r.type, year: r.year,
        cover_url: r.cover_url, format: r.format, status: r.status, author: r.author,
      }));
    },

    /** A–Z author index for the Browse-by-Author view: the letters that have
     *  authors, and (for a chosen letter/search) the authors + their counts. */
    authorsIndex({ type = null, library = null, letter = null, search = null, limit = 500, includeRestricted = false } = {}) {
      const conds = [];
      if (type) conds.push('si.type = @type');
      if (library) conds.push('si.library_id = @lib');
      if (!includeRestricted) conds.push('si.restricted = 0');
      const typeJoin = 'JOIN shelf_index si ON si.series_id = ssa.series_id' + (conds.length ? ' AND ' + conds.join(' AND ') : '');
      const p = {}; if (type) p.type = type; if (library) p.lib = library;
      const letters = db.prepare(`SELECT DISTINCT a.letter L FROM shelf_authors a
        JOIN shelf_series_authors ssa ON ssa.author_id = a.id ${typeJoin} ORDER BY a.letter`).all(p).map((r) => r.L);
      const clauses = [];
      if (letter) { clauses.push('a.letter = @letter'); p.letter = letter; }
      if (search) { clauses.push('a.sort_name LIKE @s'); p.s = '%' + lower(search) + '%'; }
      const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
      const authors = db.prepare(`SELECT a.id, a.name, a.letter, COUNT(*) c
        FROM shelf_authors a JOIN shelf_series_authors ssa ON ssa.author_id = a.id ${typeJoin}
        ${where} GROUP BY a.id ORDER BY a.sort_name LIMIT @lim`).all({ ...p, lim: Math.min(2000, limit) })
        .map((r) => ({ id: r.id, name: r.name, letter: r.letter, count: r.c }));
      return { letters, authors };
    },

    /** Resolve a facet selection to the matching series ids (for the core grid's
     *  restriction). Returns [] when nothing matches; callers treat an empty
     *  selection as "no restriction" before calling this. */
    matchingIds(userId, { authorIds = [], decades = [], formats = [], status = null, libraryId = null, includeRestricted = true } = {}) {
      const sel = { type: null, libraryId, authorIds, decades, formats, status, includeRestricted };
      const s = this._sql(userId, sel, {});
      return db.prepare(`${s.cte} SELECT si.series_id id FROM shelf_index si ${s.join} ${s.where}`)
        .all(s.params).map((r) => r.id);
    },

    close() { db.close(); },
  };
  return api;
}
