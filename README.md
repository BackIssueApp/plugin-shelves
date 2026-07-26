# Shelves plugin for BackIssue

Adds **faceted filtering** to large book and audiobook libraries. A flat grid of
tens of thousands of titles is unbrowsable, so Shelves lets you narrow it by
**author**, **decade**, **format**, and **reading status** — each with live
counts.

Shelves is a **pure data provider** — it renders no UI of its own. Core owns the
**Filters** button/modal on the Library view and the grid; Shelves answers two
questions:

1. *What facets + counts apply to the current selection?* (client
   `registerLibraryFilters`) — feeds the Filters modal.
2. *Which series match this selection?* (server `registerCollectionFilter`) — a
   set of series ids that core ANDs into `/api/collection`, so the **real** grid
   is narrowed (sorting, search, and paging keep working within the selection).

To make those answers fast at 100k+ titles, Shelves maintains its own **facet
index** (`shelf_index` + a normalized authors table) rebuilt from the core
catalog — no core schema change.

## What it provides

- **`registerLibraryFilters`** (client) for `ebook`/`audiobook` types — the
  facet groups (Author with search, Decade, Format, Reading status) the core
  Filters modal renders.
- **`registerCollectionFilter`** (server) — resolves a facet selection to the
  matching series ids that narrow the Library grid.
- A **facet index** rebuilt on demand, on a schedule, and shortly after startup
  (chunked so the server stays responsive during a large rebuild).
- Routes: `/api/shelves/facets`, `/api/shelves/authors`, `/api/shelves/status`,
  `/api/shelves/rebuild`.

The mobile apps' audiobook filters use the same `registerCollectionFilter`
resolver (via the collection `facet` param).

## Requirements

- BackIssue core with the **`registerLibraryFilters`** and
  **`registerCollectionFilter`** hooks.
- One or more **book** or **audiobook** libraries. Reading-status facets light up
  when the ebooks/audiobooks plugins' progress tables are present.

## Settings (Settings → Plugins → Shelves)

- **Enable** filtering.
- **Types** to index (default `ebook,audiobook`).

The index self-builds shortly after startup and refreshes on a schedule; you can
also rebuild it from `POST /api/shelves/rebuild` (a library manager).

## Permissions

- `library.view` — read facets.
- `library.manage` — rebuild the index.

## Roadmap

- **Genre** facet (captured from the hosted metadata service).

## License

GPL-3.0-or-later.
