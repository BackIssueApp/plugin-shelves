# Changelog

Notable, user-facing changes per release. Format follows [Keep a Changelog](https://keepachangelog.com);
versions follow the tags in this repository (`vX.Y.Z` → the release bundle BackIssue's plugin catalog installs).

Contributors: please **don't** edit this file in pull requests — entries are added
by the maintainers when changes merge, so concurrent PRs don't conflict here.

## [Unreleased]

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
