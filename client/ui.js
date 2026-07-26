// Shelves client — supplies faceted filters to core's Library Filters modal
// (registerLibraryFilters). No DOM rendering: core owns the modal + the real
// grid; this just returns facet groups + counts for the current selection, and
// the server half (registerCollectionFilter) narrows the grid to the matches.
(function () {
  window.BackIssue.registerClient((api) => {
    if (typeof api.registerLibraryFilters !== 'function') return; // older core
    const cap = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);

    api.registerLibraryFilters({
      types: ['ebook', 'audiobook'],
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
        return [
          { key: 'authors', label: 'Author', multi: true, search: true, options: (f.authors || []).map((a) => ({ value: a.id, label: a.name, count: a.count })) },
          { key: 'decades', label: 'Decade', multi: true, options: (f.decades || []).map((d) => ({ value: d.decade, label: d.decade + 's', count: d.count })) },
          { key: 'formats', label: 'Format', multi: true, options: (f.formats || []).map((x) => ({ value: x.format, label: cap(x.format), count: x.count })) },
          { key: 'status', label: 'Reading status', multi: false, options: (f.statuses || []).map((x) => ({ value: x.status, label: cap(x.status), count: x.count })) },
        ];
      },
    });
  });
})();
