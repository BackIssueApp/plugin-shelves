# Changelog

Notable, user-facing changes per release. Format follows [Keep a Changelog](https://keepachangelog.com);
versions follow the tags in this repository (`vX.Y.Z` → the release bundle BackIssue's plugin catalog installs).

Contributors: please **don't** edit this file in pull requests — entries are added
by the maintainers when changes merge, so concurrent PRs don't conflict here.

## [Unreleased]

### Changed

- **The browse index rebuilds nightly.** It was only built at startup when
  empty, so books added later didn't appear in browsing until someone rebuilt
  it by hand. Change or turn off the schedule under Jobs.
- **Listening status matches the audiobooks plugin.** An audiobook counts as
  finished in its last two minutes, or its last 1% for a long book, instead of
  only its last 30 seconds.

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
