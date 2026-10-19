# Changelog

Notable, user-facing changes per release. Format follows [Keep a Changelog](https://keepachangelog.com);
versions follow the tags in this repository (`vX.Y.Z` → the release bundle BackIssue's plugin catalog installs).

Contributors: please **don't** edit this file in pull requests — entries are added
by the maintainers when changes merge, so concurrent PRs don't conflict here.

## [Unreleased]

### Changed

- **Browsing keeps working while the index rebuilds.** A rebuild used to
  empty the index first and refill it, so for as long as it ran the facets
  and filters showed only part of the library. The new index is now built
  alongside and swapped in when it's complete. Rebuilding is also about
  three times faster (a 316,000-title library: 28 s, now 8 s) and pauses
  less in between.
- **No rebuilds in a loop during a remote catalog sync.** A sync adds titles
  all the time, so every check found the index out of date and rebuilt it
  again. Shelves now waits for the sync to finish.
- Filtering by library (as the mobile home screen's Continue listening does)
  uses an index instead of reading the whole shelf.

## [0.3.0] — 2026-10-18

### Added

- **The Shelves browser.** **Shelves** in the sidebar opens a full-screen
  browser for book and audiobook libraries: pick authors (search them, or
  browse an A to Z strip by surname), decades, formats and a reading status,
  each with live counts, and the matching covers fill the page. Search by title,
  sort by author, title, newest or recently added, and limit it to one library.
  Every cover opens its series page. On a phone the facets sit behind a
  **Filters** button.
- **A settings card.** Settings → Plugins → Shelves has the on/off switch, a
  choice of Books, Audiobooks or both, the number of titles indexed, and
  **Rebuild now**.

### Changed

- **The index keeps up with the catalog.** A check every few minutes rebuilds
  it when a scan or import adds or removes titles, so new books show up without
  waiting for the night.
- **The on/off switch works.** Turning Shelves off hides the browser and
  removes its facets from the Library Filters button; it was ignored before.
  The Library types choice now decides which libraries get the facets as well
  as which are indexed.
- **The browse index rebuilds nightly.** It was only built at startup when
  empty, so books added later didn't appear in browsing until someone rebuilt
  it by hand. Change or turn off the schedule under Jobs.
- **Listening status matches the audiobooks plugin.** An audiobook counts as
  finished in its last two minutes, or its last 1% for a long book, instead of
  only its last 30 seconds.

### Fixed

- **Mature titles for accounts allowed to see them.** Browsing hid mature
  titles from every signed-in account, admins included; they now show for
  roles with the mature-content permission, unless the account switched them
  off. The A to Z author list no longer counts mature titles for accounts that
  can't see them.

## [0.2.0] — 2026-10-17

### Added

- **Translated filters.** The Author, Decade, Format and Reading status groups
  and the reading-status values follow the language picked under Profile →
  Language on BackIssue 0.9.1 and newer, and stay English on older ones.
  Translations ship for French, German, Spanish, Italian, Portuguese (Portugal
  and Brazil), Dutch, Polish, Japanese and Simplified Chinese in `locales/`.
  Also covers the permission, job and library-type labels, the plugin
  description and the notification titles shown in BackIssue’s own screens.

## [0.1.1]

### Fixed

- **Faster facet loading.** Facet groups are cached per user and selection and
  served instantly (refreshing in the background when stale), so opening the
  Filters modal no longer recomputes several full index scans every time.

## [0.1.0]

### Added

- **Faceted library filtering.** Adds a **Filters** button to book/audiobook
  libraries (via core's Filters modal) to narrow the grid by **author**,
  **decade**, **format**, and per-user **reading status** — each with live
  counts. Filtering runs over the real grid, so sorting, search, and paging keep
  working within the selection.
- **Pure data provider** — supplies the facet groups (`registerLibraryFilters`)
  and resolves a selection to matching series ids (`registerCollectionFilter`);
  core renders the modal and the grid. The mobile apps' audiobook filters reuse
  the same server-side resolver.
- **Fast facet index** — a plugin-owned index (authors normalized) rebuilt from
  the core catalog on demand, on a schedule, and shortly after startup, chunked
  so the server stays responsive at 100k+ titles.
- Honors the per-user mature-content preference and library permissions.
