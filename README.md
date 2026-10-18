# Shelves plugin for BackIssue

Faceted browsing for large book and audiobook libraries. A flat grid of tens of
thousands of titles is unbrowsable, so Shelves lets you narrow it by
**author**, **decade**, **format** and **reading status**, each with live
counts.

## What it provides

- **A Shelves browser.** A sidebar entry opens a full-screen browser: facets on
  the left (author search plus an A to Z strip by surname, decades, formats,
  reading status), the matching covers on the right, title search, four sort
  orders, a library picker when there is more than one, and endless paging.
  Every result opens the normal series page. On a phone the facets sit behind
  a Filters button.
- **Library Filters facets.** The same facet groups feed core's **Filters**
  button on book and audiobook libraries (client `registerLibraryFilters`), and
  the server half (`registerCollectionFilter`) narrows the real grid to the
  matches, so sorting, search and paging keep working within the selection.
  The mobile apps' audiobook filters use the same resolver through the
  collection `facet` parameter.
- **A facet index** (`shelf_index` plus a normalized authors table) built from
  the core catalog, with no core schema change. It rebuilds when a check every
  few minutes finds titles added or removed, nightly through the **Rebuild the
  browse index** job, and on demand. Rebuilds are chunked so the server stays
  responsive.
- **Routes:** `/api/shelves/status`, `/api/shelves/items`,
  `/api/shelves/facets`, `/api/shelves/authors`, `/api/shelves/rebuild`.

Counts and results follow the viewer: mature titles are hidden from roles
without `library.restricted` and from accounts that switched them off, and
reading status is the viewer's own.

## Requirements

- BackIssue core with the **`registerLibraryFilters`** and
  **`registerCollectionFilter`** hooks.
- One or more **book** or **audiobook** libraries. Reading-status facets light
  up when the ebooks or audiobooks plugin's progress tables are present.

## Settings (Settings → Plugins → Shelves)

- **Shelves**: the master switch for the browser and the Library facets.
- **Library types**: Books, Audiobooks, or both (the default).
- **Rebuild now**, next to the count of indexed titles.

## Permissions

- `library.view`: browse.
- `library.manage`: rebuild the index.

## Roadmap

- **Genre** facet (captured from the hosted metadata service).

## License

GPL-3.0-or-later.
