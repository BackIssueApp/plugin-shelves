// Shelves client. Three pieces, all fed by the plugin's facet index:
//  - a "Shelves" sidebar entry opening a full-screen browser the plugin owns
//    (facet column + results grid; every result opens the core series page),
//  - facet groups for core's Library Filters modal (registerLibraryFilters),
//  - a settings card for the on/off switch and the indexed library types.
(function () {
  window.BackIssue.registerClient((api) => {
    // Translations: api.t when the host has it (BackIssue > 0.9.0), the inline
    // English otherwise. Catalog keys live under locales/<lang>.json.
    const NS = 'shelves.';
    const esc = api.escapeHtml;
    const fill = (s, p) => (p ? String(s).replace(/\{(\w+)\}/g, (m, k) => (p[k] === undefined || p[k] === null ? m : String(p[k]))) : String(s));
    const tr = (key, en, params) => { if (typeof api.t !== 'function') return fill(en, params); const v = api.t(NS + key, params); return v === NS + key ? fill(en, params) : v; };
    const te = (key, en, params) => esc(tr(key, en, params));
    // Plural strings: the catalog holds one/other forms; the English fallback
    // picks by count itself.
    const trn = (key, one, other, count) => tr(key, count === 1 ? one : other, { count, n: api.fmt ? api.fmt(count) : count });
    const cap = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
    const icon = (name) => (api.icon && api.icon(name)) || '';
    const can = (perm) => typeof api.can !== 'function' || api.can(perm);
    const store = {
      get(k) { try { return localStorage.getItem('shelves.' + k); } catch { return null; } },
      set(k, v) { try { localStorage.setItem('shelves.' + k, v); } catch { /* private mode */ } },
    };

    // Reading-status values are fixed server-side words; show them translated
    // when the catalog knows them, capitalised as before otherwise.
    const STATUS_EN = { unread: 'Unread', reading: 'Reading', finished: 'Finished' };
    const statusLabel = (s) => (STATUS_EN[s] ? tr('status.' + s, STATUS_EN[s]) : cap(s));
    const formatLabel = (f) => {
      if (f === 'audiobook') return tr('formats.audiobook', 'Audio');
      if (f === 'on-demand') return tr('formats.onDemand', 'On demand');
      return String(f || '').toUpperCase();
    };
    const decadeLabel = (d) => tr('decadeLabel', '{decade}s', { decade: d });
    const TYPES_EN = { ebook: 'Books', audiobook: 'Audiobooks' };

    // ---- Boot: is Shelves on, and for which types? ---------------------------
    let status = null;
    api.get('/api/shelves/status').then((s) => {
      status = s && !s.error ? s : null;
      if (!status || !status.enabled) return;
      registerFilters(status.types);
      addSidebarEntry();
    }).catch(() => { /* no access or older server */ });

    // ---- Core Library Filters provider --------------------------------------
    function registerFilters(types) {
      if (typeof api.registerLibraryFilters !== 'function') return; // older core
      api.registerLibraryFilters({
        types,
        // selection = { authors:[ids], decades:[nums], formats:[strs], status } —
        // the same shape the server resolver reads. ctx = { get, type, libraryId,
        // search:{ <groupKey>: text } }.
        async groups(selection, ctx) {
          const sel = selection || {};
          const p = new URLSearchParams();
          if (ctx.type) p.set('type', ctx.type);
          if (ctx.libraryId) p.set('library', ctx.libraryId);
          if (sel.authors && sel.authors.length) p.set('authors', sel.authors.join(','));
          if (sel.decades && sel.decades.length) p.set('decades', sel.decades.join(','));
          if (sel.formats && sel.formats.length) p.set('formats', sel.formats.join(','));
          if (sel.status) p.set('status', sel.status);
          if (ctx.search && ctx.search.authors) p.set('authorq', ctx.search.authors);
          let f;
          try { f = await ctx.get('/api/shelves/facets?' + p.toString()); } catch { return []; }
          if (!f || f.disabled) return [];
          return [
            { key: 'authors', label: tr('author', 'Author'), multi: true, search: true, options: (f.authors || []).map((a) => ({ value: a.id, label: a.name, count: a.count })) },
            { key: 'decades', label: tr('decade', 'Decade'), multi: true, options: (f.decades || []).map((d) => ({ value: d.decade, label: decadeLabel(d.decade), count: d.count })) },
            { key: 'formats', label: tr('format', 'Format'), multi: true, options: (f.formats || []).map((x) => ({ value: x.format, label: formatLabel(x.format), count: x.count })) },
            { key: 'status', label: tr('readingStatus', 'Reading status'), multi: false, options: (f.statuses || []).map((x) => ({ value: x.status, label: statusLabel(x.status), count: x.count })) },
          ];
        },
      });
    }

    // ---- Settings card -------------------------------------------------------
    const setSlot = api.slot('settings-plugin-panels') || api.slot('settings-plugin-sources');
    if (setSlot) {
      const block = document.createElement('div');
      block.className = 'src-block';
      block.innerHTML =
        '<div class="src-toggle">' +
          '<label class="switch"><input id="set-shelvesEnabled" type="checkbox" checked><span class="switch__track"></span></label>' +
          '<div class="src-toggle__text"><b>Shelves</b><span class="modal__note src-toggle__note">' + te('settings.intro', 'Browse book and audiobook libraries by author, decade, format and reading status, from Shelves in the sidebar and the Library Filters button.') + '</span></div>' +
        '</div>' +
        '<div class="src-config shelves-set">' +
          '<input id="set-shelvesTypes" type="hidden">' +
          '<div class="shelves-set__types"><span class="shelves-set__label">' + te('settings.types', 'Library types') + '</span>' +
            Object.keys(TYPES_EN).map((ty) => '<label class="shelves-set__type"><input type="checkbox" data-type="' + ty + '"> ' + te('settings.' + ty, TYPES_EN[ty]) + '</label>').join('') +
          '</div>' +
          '<div class="shelves-set__index"><span class="shelves-set__state modal__note"></span>' +
            (can('library.manage') ? '<button type="button" class="btn btn--ghost shelves-set__rebuild">' + te('settings.rebuild', 'Rebuild now') + '</button>' : '') +
          '</div>' +
          '<p class="modal__note">' + te('settings.note', 'The index updates on its own when titles are added or removed, and rebuilds in full every night. Changes here apply after a reload.') + '</p>' +
        '</div>';
      setSlot.appendChild(block);
      const en = block.querySelector('#set-shelvesEnabled');
      const cfg = block.querySelector('.shelves-set');
      const hidden = block.querySelector('#set-shelvesTypes');
      const boxes = [...block.querySelectorAll('[data-type]')];
      const stateEl = block.querySelector('.shelves-set__state');
      const sync = () => cfg.classList.toggle('open', en.checked);
      const fromValue = (v) => {
        const on = String(v || 'ebook,audiobook').split(',').map((x) => x.trim());
        for (const b of boxes) b.checked = on.includes(b.dataset.type);
        hidden.value = boxes.filter((b) => b.checked).map((b) => b.dataset.type).join(',');
      };
      // At least one type stays on: unticking the last one re-ticks it.
      for (const b of boxes) b.onchange = () => {
        if (!boxes.some((x) => x.checked)) b.checked = true;
        hidden.value = boxes.filter((x) => x.checked).map((x) => x.dataset.type).join(',');
      };
      const showState = async () => {
        let s;
        try { s = await api.get('/api/shelves/status'); } catch { return; }
        if (!s || s.error) return;
        const r = s.rebuild || {};
        stateEl.textContent = r.running
          ? tr('drawer.building', 'Building the browse index: {done} of {total}', { done: r.done, total: r.total })
          : s.size ? trn('settings.nIndexed', '{n} title indexed', '{n} titles indexed', s.size) : tr('settings.notBuilt', 'The browse index hasn’t been built yet.');
        if (r.running) setTimeout(showState, 2000);
      };
      const rb = block.querySelector('.shelves-set__rebuild');
      if (rb) rb.onclick = async () => {
        rb.disabled = true;
        try { await api.post('/api/shelves/rebuild'); api.toast(tr('drawer.rebuildStarted', 'Rebuilding the browse index'), 'info'); }
        catch { /* 409 while running: the state line shows it */ }
        rb.disabled = false;
        showState();
      };
      en.onchange = sync; sync(); fromValue(hidden.value);
      api.onSettingsLoad((s) => { sync(); fromValue(s && s.shelvesTypes); showState(); });
    }

    // ---- Sidebar entry + browser --------------------------------------------
    let menuBtn = null;
    function addSidebarEntry() {
      menuBtn = api.addMenuAction(tr('menu.label', 'Shelves'), openShelves, icon('layers') || '▤');
      menuBtn.title = tr('menu.title', 'Browse books and audiobooks by author, decade, format and status');
    }

    const PAGE = 60;
    const S = {
      library: Number(store.get('library')) || 0,
      sort: store.get('sort') || 'author',
      q: '',
      authors: new Map(), // id → name (kept so a chosen author outside the top list stays shown)
      decades: new Set(),
      formats: new Set(),
      status: null,
      authorQ: '',
      letter: null,
      page: 0, done: false, loading: false, token: 0,
    };
    let el = null; // the overlay and its parts

    const libraries = () => (api.libraries ? api.libraries() : []).filter((l) => (status ? status.types : ['ebook', 'audiobook']).includes(l.type));
    const activeCount = () => S.authors.size + S.decades.size + S.formats.size + (S.status ? 1 : 0);
    function query(extra) {
      const p = new URLSearchParams();
      const libs = libraries();
      if (S.library && libs.some((l) => l.id === S.library)) p.set('library', S.library);
      else if (status && status.types.length === 1) p.set('type', status.types[0]);
      if (S.q) p.set('q', S.q);
      if (S.authors.size) p.set('authors', [...S.authors.keys()].join(','));
      if (S.decades.size) p.set('decades', [...S.decades].join(','));
      if (S.formats.size) p.set('formats', [...S.formats].join(','));
      if (S.status) p.set('status', S.status);
      for (const [k, v] of Object.entries(extra || {})) if (v !== null && v !== undefined && v !== '') p.set(k, v);
      return p.toString();
    }

    function openShelves() {
      if (!el) build();
      el.root.classList.add('is-open');
      paintLibraries();
      refresh();
      // Typing is the quickest way in on a desktop; on a touch screen focusing
      // would throw the keyboard over the shelves.
      if (!window.matchMedia || !window.matchMedia('(hover: none)').matches) setTimeout(() => el.search.focus(), 0);
    }
    function closeShelves() {
      if (!el) return;
      el.root.classList.remove('is-open', 'is-filtering');
      el.filtersBtn.classList.remove('is-on');
      if (menuBtn) menuBtn.focus();
    }

    function build() {
      const root = document.createElement('div');
      root.className = 'shelves';
      root.innerHTML =
        '<div class="shelves__backdrop"></div>' +
        '<div class="shelves__panel" role="dialog" aria-modal="true" aria-label="' + te('drawer.label', 'Browse shelves') + '">' +
          '<div class="shelves__head">' +
            '<div class="shelves__title">' + te('menu.label', 'Shelves') + '</div>' +
            '<select class="shelves__lib" aria-label="' + te('drawer.library', 'Library') + '"></select>' +
            '<input class="shelves__search" type="search" placeholder="' + te('drawer.search', 'Search titles') + '" aria-label="' + te('drawer.search', 'Search titles') + '">' +
            '<label class="shelves__sortwrap"><span>' + te('sort.label', 'Sort') + '</span><select class="shelves__sort">' +
              '<option value="author">' + te('sort.author', 'Author') + '</option>' +
              '<option value="title">' + te('sort.title', 'Title') + '</option>' +
              '<option value="year">' + te('sort.year', 'Newest first') + '</option>' +
              '<option value="added">' + te('sort.added', 'Recently added') + '</option>' +
            '</select></label>' +
            '<button type="button" class="btn btn--ghost shelves__filtersbtn"></button>' +
            '<button type="button" class="shelves__close" title="' + te('drawer.close', 'Close (Esc)') + '" aria-label="' + te('drawer.close', 'Close (Esc)') + '">' + (icon('close') || '✕') + '</button>' +
          '</div>' +
          '<div class="shelves__body">' +
            '<aside class="shelves__aside"></aside>' +
            '<button type="button" class="btn btn--primary shelves__done">' + te('drawer.showResults', 'Show results') + '</button>' +
            '<section class="shelves__main">' +
              '<div class="shelves__bar"><span class="shelves__total"></span><span class="shelves__chips"></span></div>' +
              '<div class="shelves__grid"></div>' +
              '<div class="shelves__more"></div>' +
            '</section>' +
          '</div>' +
        '</div>';
      document.body.appendChild(root);
      el = {
        root,
        lib: root.querySelector('.shelves__lib'),
        search: root.querySelector('.shelves__search'),
        sort: root.querySelector('.shelves__sort'),
        filtersBtn: root.querySelector('.shelves__filtersbtn'),
        aside: root.querySelector('.shelves__aside'),
        main: root.querySelector('.shelves__main'),
        total: root.querySelector('.shelves__total'),
        chips: root.querySelector('.shelves__chips'),
        grid: root.querySelector('.shelves__grid'),
        more: root.querySelector('.shelves__more'),
      };
      el.sort.value = S.sort;
      root.querySelector('.shelves__backdrop').onclick = closeShelves;
      root.querySelector('.shelves__close').onclick = closeShelves;
      el.filtersBtn.onclick = () => el.filtersBtn.classList.toggle('is-on', root.classList.toggle('is-filtering'));
      root.querySelector('.shelves__done').onclick = () => { root.classList.remove('is-filtering'); el.filtersBtn.classList.remove('is-on'); };
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !root.classList.contains('is-open')) return;
        if (root.classList.contains('is-filtering')) { root.classList.remove('is-filtering'); el.filtersBtn.classList.remove('is-on'); }
        else closeShelves();
      });
      el.lib.onchange = () => { S.library = Number(el.lib.value) || 0; store.set('library', String(S.library)); clearSelection(); refresh(); };
      el.sort.onchange = () => { S.sort = el.sort.value; store.set('sort', S.sort); refresh({ itemsOnly: true }); };
      let qTimer = null;
      el.search.oninput = () => { clearTimeout(qTimer); qTimer = setTimeout(() => { S.q = el.search.value.trim(); refresh(); }, 250); };
      // Endless paging: the next page loads as the end of the grid scrolls in.
      if ('IntersectionObserver' in window) {
        new IntersectionObserver((ents) => { if (ents.some((x) => x.isIntersecting)) loadMore(); }, { root: el.main, rootMargin: '400px' }).observe(el.more);
      }
    }

    function paintLibraries() {
      const libs = libraries();
      el.lib.hidden = libs.length < 2;
      if (S.library && !libs.some((l) => l.id === S.library)) S.library = 0;
      el.lib.innerHTML = '<option value="0">' + te('drawer.allLibraries', 'All libraries') + '</option>' +
        libs.map((l) => '<option value="' + l.id + '">' + esc(l.name) + '</option>').join('');
      el.lib.value = String(S.library);
    }

    function clearSelection() {
      S.authors.clear(); S.decades.clear(); S.formats.clear(); S.status = null;
      S.authorQ = ''; S.letter = null;
    }

    // Fetch facets + the first page for the current selection. A newer call
    // retires an older one's answers (token), so fast clicking never paints a
    // stale grid.
    async function refresh({ itemsOnly = false } = {}) {
      const token = ++S.token;
      S.page = 0; S.done = false;
      el.more.innerHTML = '';
      paintChips();
      if (!itemsOnly) el.aside.classList.add('is-loading');
      el.grid.classList.add('is-loading');
      let st;
      try { st = await api.get('/api/shelves/status'); } catch { st = null; }
      if (token !== S.token) return;
      if (st && st.enabled === false) return note(tr('drawer.disabled', 'Shelves is turned off. Turn it on under Settings → Plugins.'));
      if (st && st.rebuild && st.rebuild.running && !st.size) return building(st.rebuild, token);
      if (st && !st.size) return emptyIndex();
      const facetsP = itemsOnly ? null : api.get('/api/shelves/facets?' + query({ authorq: S.authorQ }));
      const lettersP = itemsOnly ? null : api.get('/api/shelves/authors?' + authorsQuery());
      try {
        const [items, facets, letters] = await Promise.all([fetchPage(0), facetsP, lettersP]);
        if (token !== S.token) return;
        if (facets) { paintFacets(facets, letters); paintTotal(facets.total); }
        el.grid.innerHTML = '';
        appendItems(items);
        if (!items.length) el.grid.innerHTML = '<div class="shelves__note">' + te('drawer.noMatches', 'Nothing matches these filters.') + (activeCount() || S.q ? ' <button type="button" class="shelves__link" data-clear>' + te('drawer.clear', 'Clear all') + '</button>' : '') + '</div>';
        const c = el.grid.querySelector('[data-clear]');
        if (c) c.onclick = () => { clearSelection(); S.q = ''; el.search.value = ''; refresh(); };
      } catch (e) {
        if (token !== S.token) return;
        note(tr('drawer.loadFailed', 'Couldn’t load the shelves: {error}', { error: String(e && e.message || e) }), true);
      } finally {
        if (token === S.token) { el.aside.classList.remove('is-loading'); el.grid.classList.remove('is-loading'); }
      }
    }
    async function fetchPage(page) {
      const r = await api.get('/api/shelves/items?' + query({ sort: S.sort, page, limit: PAGE }));
      const items = (r && r.items) || [];
      if (items.length < PAGE) S.done = true;
      return items;
    }
    async function loadMore() {
      if (!el || !el.root.classList.contains('is-open') || S.done || S.loading || !el.grid.querySelector('.shelf-card')) return;
      S.loading = true;
      const token = S.token;
      try {
        const items = await fetchPage(S.page + 1);
        if (token !== S.token) return;
        S.page++;
        appendItems(items);
      } catch { S.done = true; }
      finally { S.loading = false; }
    }

    function note(html, bad) {
      el.aside.classList.remove('is-loading'); el.grid.classList.remove('is-loading');
      el.aside.innerHTML = '';
      el.total.textContent = '';
      el.grid.innerHTML = '<div class="shelves__note' + (bad ? ' shelves__note--bad' : '') + '">' + esc(html) + '</div>';
    }
    function emptyIndex() {
      note(tr('drawer.empty', 'Nothing is indexed yet.'));
      const n = el.grid.querySelector('.shelves__note');
      n.insertAdjacentHTML('beforeend', '<p>' + te('drawer.emptyHint', 'Add a Books or Audiobooks library, or rebuild the browse index if you already have one.') + '</p>');
      if (can('library.manage')) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'btn btn--primary'; b.textContent = tr('drawer.rebuild', 'Rebuild index');
        b.onclick = async () => { b.disabled = true; try { await api.post('/api/shelves/rebuild'); } catch { /* already running */ } refresh(); };
        n.appendChild(b);
      }
    }
    function building(r, token) {
      note(tr('drawer.building', 'Building the browse index: {done} of {total}', { done: api.fmt ? api.fmt(r.done) : r.done, total: api.fmt ? api.fmt(r.total) : r.total }));
      setTimeout(() => { if (token === S.token && el.root.classList.contains('is-open')) refresh(); }, 2000);
    }

    function paintTotal(n) {
      el.total.textContent = trn('drawer.nTitles', '{n} title', '{n} titles', n || 0);
      const a = activeCount();
      el.filtersBtn.textContent = a ? tr('drawer.filtersN', 'Filters ({count})', { count: a }) : tr('drawer.filters', 'Filters');
    }

    // Active selections as removable chips above the grid.
    function paintChips() {
      const chips = [];
      for (const [id, name] of S.authors) chips.push({ label: name, drop: () => S.authors.delete(id) });
      for (const d of S.decades) chips.push({ label: decadeLabel(d), drop: () => S.decades.delete(d) });
      for (const f of S.formats) chips.push({ label: formatLabel(f), drop: () => S.formats.delete(f) });
      if (S.status) chips.push({ label: statusLabel(S.status), drop: () => { S.status = null; } });
      el.chips.innerHTML = '';
      for (const c of chips) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'shelves__chip';
        b.title = tr('drawer.remove', 'Remove {name}', { name: c.label });
        b.innerHTML = esc(c.label) + '<span aria-hidden="true">' + (icon('close') || '✕') + '</span>';
        b.onclick = () => { c.drop(); refresh(); };
        el.chips.appendChild(b);
      }
      if (chips.length > 1) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'shelves__link'; b.textContent = tr('drawer.clear', 'Clear all');
        b.onclick = () => { clearSelection(); refresh(); };
        el.chips.appendChild(b);
      }
    }

    function authorsQuery() {
      const p = new URLSearchParams(query());
      for (const k of ['q', 'authors', 'decades', 'formats', 'status']) p.delete(k);
      p.set('letter', S.letter || 'A'); // the response's letter list is what we need; one letter keeps it light
      return p.toString();
    }

    // The facet column. Each group's counts already apply every other chosen
    // dimension (server side), so picking widens or narrows predictably.
    function paintFacets(f, letters) {
      const aside = el.aside;
      const keepFocus = document.activeElement && document.activeElement.classList.contains('shelves__authorq');
      aside.innerHTML = '';
      const group = (title) => {
        const g = document.createElement('div'); g.className = 'shelves__group';
        g.innerHTML = '<div class="shelves__gtitle">' + esc(title) + '</div>';
        aside.appendChild(g); return g;
      };
      const option = (parent, { label, count, on, onClick, cls }) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = (cls || 'shelves__opt') + (on ? ' is-on' : '');
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        b.innerHTML = '<span class="shelves__optlabel">' + esc(label) + '</span>' + (count !== undefined ? '<span class="shelves__count">' + esc(api.fmt ? api.fmt(count) : count) + '</span>' : '');
        b.onclick = onClick;
        parent.appendChild(b); return b;
      };

      // Author: search, an A–Z strip, then the list (chosen ones first).
      const ga = group(tr('author', 'Author'));
      const aq = document.createElement('input');
      aq.type = 'search'; aq.className = 'shelves__authorq'; aq.value = S.authorQ;
      aq.placeholder = tr('authors.search', 'Find an author'); aq.setAttribute('aria-label', aq.placeholder);
      let aTimer = null;
      aq.oninput = () => { clearTimeout(aTimer); aTimer = setTimeout(() => { S.authorQ = aq.value.trim(); S.letter = null; refreshAuthors(); }, 250); };
      ga.appendChild(aq);
      const strip = document.createElement('div'); strip.className = 'shelves__letters';
      const ls = (letters && letters.letters) || [];
      if (ls.length > 1) {
        option(strip, { label: tr('authors.top', 'Top'), on: !S.letter, cls: 'shelves__letter', onClick: () => { S.letter = null; refreshAuthors(); } }).dataset.letter = '';
        for (const L of ls) option(strip, { label: L, on: S.letter === L, cls: 'shelves__letter', onClick: () => { S.letter = S.letter === L ? null : L; refreshAuthors(); } }).dataset.letter = L;
        ga.appendChild(strip);
      }
      const list = document.createElement('div'); list.className = 'shelves__authors';
      ga.appendChild(list);
      el.authorList = list;
      paintAuthorList(S.letter ? null : f.authors);
      if (S.letter) refreshAuthors();
      if (keepFocus) { aq.focus(); aq.setSelectionRange(aq.value.length, aq.value.length); }

      const chipGroup = (title, opts, isOn, toggle) => {
        if (!opts.length) return;
        const g = group(title);
        const wrap = document.createElement('div'); wrap.className = 'shelves__chipset';
        for (const o of opts) option(wrap, { label: o.label, count: o.count, on: isOn(o.value), cls: 'shelves__pill', onClick: () => { toggle(o.value); refresh(); } });
        g.appendChild(wrap);
      };
      chipGroup(tr('decade', 'Decade'), (f.decades || []).map((d) => ({ value: d.decade, label: decadeLabel(d.decade), count: d.count })),
        (v) => S.decades.has(v), (v) => (S.decades.has(v) ? S.decades.delete(v) : S.decades.add(v)));
      chipGroup(tr('format', 'Format'), (f.formats || []).map((x) => ({ value: x.format, label: formatLabel(x.format), count: x.count })),
        (v) => S.formats.has(v), (v) => (S.formats.has(v) ? S.formats.delete(v) : S.formats.add(v)));
      chipGroup(tr('readingStatus', 'Reading status'), (f.statuses || []).map((x) => ({ value: x.status, label: statusLabel(x.status), count: x.count })),
        (v) => S.status === v, (v) => { S.status = S.status === v ? null : v; });
    }

    // Author list: the selection's top authors (from facets), or one letter's
    // authors / a name search across the library.
    async function refreshAuthors() {
      const token = S.token;
      let rows;
      try {
        if (S.letter) {
          const p = new URLSearchParams(authorsQuery()); p.set('letter', S.letter);
          rows = ((await api.get('/api/shelves/authors?' + p.toString())).authors || []);
        } else {
          rows = ((await api.get('/api/shelves/facets?' + query({ authorq: S.authorQ }))).authors || []);
        }
      } catch { rows = []; }
      if (token !== S.token) return;
      for (const b of el.aside.querySelectorAll('.shelves__letter')) {
        const on = b.dataset.letter === (S.letter || '');
        b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
      paintAuthorList(rows);
    }
    function paintAuthorList(rows) {
      const list = el.authorList;
      if (!list) return;
      if (!rows) { list.innerHTML = '<div class="shelves__hint">' + te('drawer.loading', 'Loading…') + '</div>'; return; }
      list.innerHTML = '';
      const shown = new Set();
      const add = (id, name, count) => {
        shown.add(id);
        const on = S.authors.has(id);
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'shelves__opt' + (on ? ' is-on' : '');
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        b.innerHTML = '<span class="shelves__check" aria-hidden="true">' + (on ? (icon('check') || '✓') : '') + '</span><span class="shelves__optlabel">' + esc(name) + '</span>' + (count !== undefined ? '<span class="shelves__count">' + esc(api.fmt ? api.fmt(count) : count) + '</span>' : '');
        b.onclick = () => { if (S.authors.has(id)) S.authors.delete(id); else S.authors.set(id, name); refresh(); };
        list.appendChild(b);
      };
      for (const [id, name] of S.authors) { const r = rows.find((x) => x.id === id); add(id, name, r ? r.count : undefined); }
      for (const r of rows) if (!shown.has(r.id)) add(r.id, r.name, r.count);
      if (!list.children.length) list.innerHTML = '<div class="shelves__hint">' + te('authors.none', 'No authors match.') + '</div>';
    }

    // Result cards. Audiobook covers are square, book covers portrait.
    const initials = (t) => String(t || '?').replace(/^(the|a|an)\s+/i, '').split(/\s+/).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join('');
    function appendItems(items) {
      const frag = document.createDocumentFragment();
      for (const it of items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'shelf-card' + (it.type === 'audiobook' ? ' shelf-card--audio' : '');
        const src = it.cover_url ? api.safeUrl(it.cover_url) : '';
        const badge = it.status === 'finished' ? '<span class="shelf-card__badge shelf-card__badge--done" title="' + esc(statusLabel('finished')) + '">' + (icon('check') || '✓') + '</span>'
          : it.status === 'reading' ? '<span class="shelf-card__badge" title="' + esc(statusLabel('reading')) + '">' + esc(statusLabel('reading')) + '</span>' : '';
        b.innerHTML =
          '<span class="shelf-card__art cover"><span class="cover__ph">' + esc(initials(it.title)) + '</span>' +
            (src ? '<img loading="lazy" alt="" referrerpolicy="no-referrer" src="' + esc(src) + '">' : '') + badge + '</span>' +
          '<span class="shelf-card__title">' + esc(it.title || '') + '</span>' +
          '<span class="shelf-card__meta">' + esc([it.author, it.year].filter(Boolean).join(' · ')) + '</span>';
        const img = b.querySelector('img');
        if (img) img.onerror = () => img.remove();
        b.onclick = () => { closeShelves(); api.openSeries(it.id); };
        frag.appendChild(b);
      }
      el.grid.appendChild(frag);
      el.more.innerHTML = '';
      if (!S.done && items.length) {
        const m = document.createElement('button');
        m.type = 'button'; m.className = 'btn btn--ghost'; m.textContent = tr('drawer.loadMore', 'Load more');
        m.onclick = loadMore;
        el.more.appendChild(m);
      }
    }
  });
})();
