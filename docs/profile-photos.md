# Profile Pictures

Account settings → **Profile picture** provides Upload, Replace and Remove controls. PNG, JPEG and WebP source files up to 10 MiB are accepted by the browser. The browser crops the center square, resizes to at most 512 × 512 pixels and re-encodes as JPEG before upload; transparent areas become white. Saved uploads must fit the server's 512 KiB limit. Profile fields and password drafts remain mounted while a photo saves, and the account-save and photo-save controls prevent overlapping mutations.

The shared `Avatar` component displays profile photos in the sidebar, profile preview and task/document comment headers. It retains the existing initial when there is no photo or an image fails to load. Only the authenticated same-origin photo URL shape is accepted. New photo revisions reset image loading; there is no external-avatar service or cloud requirement.

## API And Persistence

- `PUT /api/v1/auth/profile/photo` accepts `{contentType,data}` with canonical base64 data. It always targets the authenticated account. Unknown fields, including a proposed target user ID, are rejected.
- `DELETE /api/v1/auth/profile/photo` removes the authenticated account's picture; repeating removal is harmless.
- Both mutations return `{photoUrl: string | null}` and reauthenticate inside the transaction. Cookie requests retain the same-origin mutation boundary. Photo changes and size/type-only `user.photo.update` or count-only `user.photo.delete` audits commit together.
- `GET /api/v1/users/:id/photo?v=:revision` serves the current picture only to its owner, another current member of a shared workspace, or an authenticated site admin. Disabled accounts have no readable photo. Authentication, sharing and the exact photo revision are rechecked before returning bytes. A remembered URL grants no access; replaced revisions, removed photos and invisible accounts return 404.
- Successful reads use the byte-derived PNG/JPEG/WebP MIME, inline disposition, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`, same-origin resource policy and sandbox/default-none CSP.

The server independently validates PNG/JPEG/WebP raster containers and dimensions using the existing `rasterContentType` helper, matches declared MIME to detected bytes, and bounds decoded upload bytes to 512 KiB. SVG, GIF, HTML, malformed data and MIME mismatches are rejected. The existing raster validator limits direct API images to 40 megapixels and 16,384 pixels per dimension; it validates containers rather than transcoding pixels. Browser uploads are resized to the smaller profile dimensions above.

Migration `0011_profile_photos` creates a separate account-scoped table with one photo per user. Its binary column is bounded by size and byte-length constraints, with a raster MIME allowlist and a cascading user foreign key. Replacing a photo replaces its row and assigns a fresh revision. SQLite and PostgreSQL use native binary storage; existing user and content tables are not rebuilt. Ordinary database backup/restore includes profile pictures.

`GET /auth/me`, successful profile updates, admin account lists and authorized member metadata provide safe `photoUrl` metadata only. Task/document comment responses include `authorPhotoUrl` only for an active author still in that workspace; removed or unavailable authors fall back to initials. No picture bytes are added to user JSON, comments, workspace exports or audit details. Workspace exports remain workspace-scoped rather than including global account pictures.

## Verification

2026-10-02, pinned Node 24.20.0:

- `npm run typecheck --workspace=@hopya/api` passes.
- `npm run typecheck --workspace=@hopya/web` passes, 117 files with zero errors/warnings/hints.
- Focused `accounts.test.ts` passes all 9 tests. Its new distinct regression verifies replacement/removal rollback on audit failure and credential withdrawal between initial authentication and the mutation transaction.
- The real HTTP contract suite passes (1 umbrella test), extended for absent-photo defaults, self-only upload/removal, unknown target rejection, origin/anonymous rejection, byte/MIME/size validation, private binary headers, current shared-workspace access and its revocation, site-admin preview, replacement revisions, metadata persistence through profile saves, member/task-comment/document-comment wiring, and safe export/audit output.
- A disposable PostgreSQL 17 application check passes all migrations and binary upload/read/replacement/removal, revision metadata and audit assertions. The database, container and temporary files were cleaned up.
- `git diff --check` passes.
- After the migration and focused account checks passed, the official pinned-Node command `node ace.js migration:run --no-schema-generate` applied `0011_profile_photos` to the existing development database in 28 ms, as authorized to keep hot-reloading metadata reads usable. No service restart, browser operation or owner photo/data mutation was performed.
- Browser image decoding/resizing, file-picker/focus interaction, draft retention and final mobile rendering remain unverified; no automated browser suite was run for these changes.

The shared `Avatar` and `ProfilePhoto` components use `apps/web/src/styles/profile-photos.css` and the existing avatar geometry/initial styling.
