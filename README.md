# Hopya

Hopya is a self-hosted task manager for teams that want a private, straightforward workspace without a mandatory cloud service. Organize work into projects, folders, and lists, then use List, Board, Calendar, Table, or Timeline views over the same tasks.

> Hopya is an early release. Back up your data and review the [security](docs/security.md) and [deployment](docs/deployment.md) guidance before using it for important workloads.

## Features

- Multiple workspaces with protected ownership, members, and custom roles
- Projects, folders, lists, tasks, subtasks, checklists, statuses, priorities, tags, dates, and assignees
- Workspace Inbox notifications, user/task/structure mentions, threaded comments, and emoji reactions
- Configurable text, number, date, datetime, checkbox, select, checklist, rating, and formula fields
- List, Board, Calendar, Table, Timeline, and Gallery views
- Private attachments on local storage or an optional S3-compatible service
- Local accounts, optional OIDC sign-in, password recovery, revocable API tokens, and audit records
- JSON/CSV task import and export, plus complete workspace JSON exports
- Optional webhook, email, HTTP automation, AI-assisted proposals, and MCP access
- Responsive layouts and keyboard-accessible controls

## Quick Start

You need Docker Engine and Docker Compose. Node.js 24 is optional and only needed for the easiest configuration initializer and local development.

1. Generate a private `.env`:

   ```sh
   npm run init:env
   ```

   Without Node.js on the host, run the initializer through Docker:

   ```sh
   docker run --rm --network none --read-only --cap-drop ALL \
     --security-opt no-new-privileges:true --user "$(id -u):$(id -g)" \
     -v "$PWD:/work" -w /work node:24-bookworm-slim \
     node --experimental-strip-types ops/init-env.ts
   ```

2. Start Hopya:

   ```sh
   docker compose up -d --build --wait
   ```

3. Open [http://localhost:8080](http://localhost:8080), then create the first administrator using `SETUP_TOKEN` from `.env`.

The default deployment listens only on `127.0.0.1`. For remote access, place Hopya behind a trusted HTTPS reverse proxy and set `APP_URL` to the exact public origin. Do not expose the private API or web containers directly.

Useful commands:

```sh
docker compose ps
docker compose logs -f api web proxy
docker compose pull
docker compose up -d --build --wait
docker compose down
```

Do not use `docker compose down -v` unless you intentionally want to delete all Hopya data.

## First Workspace

1. Select **Create your first workspace**. It becomes the active workspace automatically.
2. Add a project and a list. Folders are optional.
3. Create a task and switch between views as needed.
4. Open **Settings** to manage members, roles, fields, exports, and workspace ownership actions.
5. Open **Account settings** from the user menu to update personal details or credentials.

See the [user guide](docs/user-guide.md) for everyday workflows and permissions.

## Configuration

The generated `.env` contains the required private values. Keep it out of Git and backups that are not encrypted.

| Setting | Purpose |
| --- | --- |
| `APP_URL` | Exact browser origin, including HTTPS and a nonstandard port if used |
| `APP_KEY` | Stable application secret; changing it invalidates signed state |
| `SETUP_TOKEN` | One-time secret used to create the first administrator |
| `BIND_ADDRESS`, `HTTP_PORT` | Host listener; defaults to `127.0.0.1:8080` |
| `LANDING_ENABLED` | Show or skip the public landing page |
| `REGISTRATION_ENABLED` | Allow public local-account registration; off by default |
| `SMTP_URL`, `SMTP_FROM` | Enable password recovery and email delivery |
| `STORAGE_DRIVER`, `S3_*`, `AWS_*` | Select filesystem or private S3-compatible attachments |
| `OIDC_*` | Configure an optional standards-compliant OIDC provider |
| `AI_*` | Configure an optional AI provider and model |

All integrations are optional. Empty provider settings keep the cloud-free core operational. See [deployment](docs/deployment.md), [integrations](docs/integrations.md), and [OIDC setup](docs/oidc-setup.md) for details.

## Landing Page

The public root page is intentionally basic. To change its headline, description, button label, or footer note, edit the four plain-text values in `apps/web/src/landing.json`. Keep the file valid JSON; HTML is not supported.

Rebuild the web image after editing:

```sh
docker compose up -d --build web
```

Set `LANDING_ENABLED=false` in `.env` and recreate the web service to redirect `/` to sign-in instead. Site administrators can also control landing-page visibility from **Settings**.

## Data And Backups

Application data is stored in the `hopya_data` Docker volume. Workspace exports do not include account credentials or attachment bytes and are not complete backups.

For a reliable backup:

1. Stop Hopya so SQLite and attachment writes are closed.
2. Archive the entire `/data` volume.
3. Store an encrypted copy of `.env` separately.
4. Test restoration into a new volume before relying on the backup.

Follow the [backup and restore guide](docs/deployment.md#backup-and-restore) for commands and recovery cautions.

## Development

Use Node.js 24, pinned in `.node-version`.

```sh
npm run init:env -- --development
npm ci
npm run dev
```

Open `http://localhost:4321`. Before submitting changes, run:

```sh
npm run check
```

The normal check runs TypeScript validation, API/unit tests, and production builds. Browser tests are separate:

```sh
npm run test:browser
```

The GitHub Actions workflow runs dependency auditing, checks, compiled application tests, browser tests, and isolated Docker deployment verification.

## API And MCP

The REST API is available under `/api/v1`. Create a personal token in **Settings** and send it as `Authorization: Bearer <token>`. See the [REST reference](docs/api.md).

MCP supports a local stdio process:

```text
Command: node
Arguments: apps/api/build/bin/mcp.js
Working directory: /absolute/path/to/hopya
Environment:
  HOPYA_API_URL=http://localhost:8080
  HOPYA_API_TOKEN=<personal token>
```

MCP is read-only by default. For Docker Compose, set `HOPYA_MCP_ALLOW_WRITES=true` in `.env` and recreate the API service to expose mutation tools; the MCP client must still obtain explicit human approval for each write.

Site administrators may also enable the disabled-by-default SSE transport in **Settings > Site settings**. Connect an SSE-compatible MCP client to `https://your-hopya.example/api/v1/mcp/sse` and configure `Authorization: Bearer <personal token>` as a header. Never place the token in the URL. Disabling SSE immediately closes active sessions; sessions otherwise expire after 30 minutes. Both transports expose the same tools and enforce the token owner's current workspace permissions.

## Documentation

- [Deployment and recovery](docs/deployment.md)
- [User guide](docs/user-guide.md)
- [Security boundaries](docs/security.md)
- [Integrations](docs/integrations.md)
- [OIDC setup](docs/oidc-setup.md)
- [REST API](docs/api.md)
- [Architecture](docs/architecture.md)

## License

Hopya is available under the [MIT License](LICENSE).
