# Sidebar Attribution And Resource Icons

## Administration

Administration → Site settings → **By WNZN attribution** controls the sidebar attribution for the entire instance. The switch defaults to shown, including existing installations without a stored value. Saving refreshes the current sidebar; other pages read the setting on load and when their window regains focus.

`GET /api/v1/config` exposes the safe boolean `showSidebarAttribution`. Site administrators can read it through `GET /api/v1/site/settings` and change it with:

```json
{ "showSidebarAttribution": false }
```

`PATCH /api/v1/site/settings` requires current site-admin authentication and the existing browser same-origin boundary. Validation accepts a boolean only. The setting and `site.settings.update` audit commit together. Missing/null storage means visible; the persisted string `0` means hidden. No workspace role can change this global setting.

## Heading Icons

Click a Project, Folder, List, Document/page or Table heading's icon to choose from the existing searchable Runeicons catalog. Clicking the title separately opens its rename editor. Choosing an icon saves immediately; **Default** restores the resource-type glyph. The heading and hierarchy use the same metadata. Details uses the same picker and the existing validated hex-color controls, including for Tables and Documents.

The picker provides a named button, search autofocus, native buttons with selected state, arrow/Home/End navigation, Escape/explicit-close dismissal and focus return after selection/cancellation. Its panel is bounded to the current visual viewport and its grid scrolls independently. Compact mobile triggers are 44px. Save failures are displayed in the picker, and stale document/Table revisions require reloading rather than overwriting a concurrent update.

Document icon/title saves merge returned metadata locally instead of reloading the entire workspace. This preserves an in-progress body draft and keeps the icon trigger mounted for focus restoration. Re-selecting the active workspace in the dashboard also returns early so it cannot clear open editors or drafts.

Project/Folder/List writes require `structure:write`. Updating existing Documents requires both `documents:read` and `documents:write`; existing Tables require both `tables:read` and `tables:write`. Creation retains the dedicated write permission. Every API mutation validates its workspace and resource server-side and commits with its audit.

## Persistence And API

Migration `0009_resource_appearance` adds nullable `icon` and `color` columns to Documents and Tables. SQLite uses native additive operations to preserve referenced pages, comments, reactions, columns and records. Existing resources receive null defaults. PostgreSQL uses additive schema changes.

`app/appearance.ts` supplies the existing icon allowlist and color normalization to nodes, documents and tables. Icons are catalog IDs, not SVG/HTML; colors are lowercase six-digit hex strings, with the established named-color aliases accepted on input. Null clears either field. Document/Table create and PATCH routes accept the fields, and their individual reads, hierarchy summaries and complete workspace exports include them. PATCH requires the current `expectedUpdatedAt`. Document appearance edits advance metadata attribution/version while preserving body text and `bodyRevision`/quote anchors.

Complete workspace exports include appearance (the current image-aware format is version 8). Per-Table CSV/typed-JSON transfer is still a columns/records transfer and does not round-trip appearance; use the workspace export for that metadata.

## Implementation And Verification

`NodeIconPicker.tsx` and `styles/appearance.css` provide the shared heading and management controls. Branding lookups use `Effect.tryPromise` and the shared `runPromiseThrow` boundary, preserving the original `HttpError` and missing-logo 404.

The existing HTTP, Document, Table, migration and shared-navigation tests cover attribution defaults, safe config, authorization and same-origin enforcement, audit rollback, appearance validation/revisions, document-body preservation, export metadata and additive upgrades. Focused SQLite and disposable PostgreSQL 17 checks pass under Node 24.20.0. Live desktop/mobile inspection confirms picker containment, search and dismissal and the attribution switch; saving appearance, keyboard-only focus and physical touch remain unverified. No automated browser suite was run for these changes.
