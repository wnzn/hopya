# Deployment

Hopya runs as one API replica with either SQLite on local persistent storage or PostgreSQL. Do not place SQLite on NFS or run multiple API replicas; multi-replica operation is not a supported topology even with PostgreSQL.

## Architecture

```text
Browser -> 127.0.0.1:8888 -> Nginx -> Astro
                                  -> AdonisJS -> SQLite /data or PostgreSQL
```

`docker-compose.yml` builds separate API and web images, runs every service with a read-only root filesystem and dropped capabilities, and publishes only the Nginx proxy. The API is the only service with access to application secrets and the ignored `./data` host directory.

## Install

Generate a private configuration file:

```sh
npm run init:env
```

The initializer creates independent `APP_KEY` and `SETUP_TOKEN` values, writes `.env` with owner-only permissions, creates a private writable `./data` directory, and refuses to replace an existing configuration. The README includes a Docker-only initializer command for hosts without Node.js.

Validate and start the stack:

```sh
docker compose config --quiet
docker compose up -d --build --wait
docker compose ps
```

Open `http://localhost:8888` and create the first administrator with `SETUP_TOKEN` from `.env`. There are no default accounts. Public registration is disabled unless `REGISTRATION_ENABLED=true`.

## Configuration

`.env.example` lists every Compose setting. Keep the real `.env` private and retain an encrypted backup of it.

| Variable | Purpose |
| --- | --- |
| `APP_URL` | Exact public browser origin, without a path prefix |
| `APP_KEY` | Stable application secret; do not rotate during routine upgrades |
| `SETUP_TOKEN` | Secret accepted only while creating the first account |
| `BIND_ADDRESS`, `HTTP_PORT` | Proxy listener, default `127.0.0.1:8888` |
| `LANDING_ENABLED` | Enable the optional public landing page; defaults to `false` |
| `REGISTRATION_ENABLED` | Allow public local-account registration |
| `SMTP_URL`, `SMTP_FROM` | Enable password recovery and email automation |
| `STORAGE_DRIVER`, `S3_*`, `AWS_*` | Configure filesystem or S3-compatible attachments |
| `OIDC_*` | Configure optional OpenID Connect sign-in |
| `AI_*` | Configure the optional AI assistant |
| `DB_CONNECTION`, `DATABASE_URL` | Select `sqlite` (default) or a PostgreSQL connection |
| `COMPOSE_PROFILES`, `POSTGRES_*` | Enable and configure the optional bundled PostgreSQL service |

After changing environment values, recreate affected services:

```sh
docker compose up -d --force-recreate api web proxy
```

`docker compose restart` does not load changed environment values.

### PostgreSQL

The initializer generates a private PostgreSQL password and matching URL but leaves SQLite selected. For a new PostgreSQL deployment, set these two values in `.env` before first startup:

```dotenv
COMPOSE_PROFILES=postgres
DB_CONNECTION=pg
```

The generated `DATABASE_URL` points to the bundled `postgres` service. For an external PostgreSQL server, leave `COMPOSE_PROFILES` empty and set `DATABASE_URL` to that server instead. Treat switching engines as a data migration; changing the variables does not copy an existing SQLite or PostgreSQL database.

## Customize The Landing Page

The intentionally basic public page reads four plain-text values from `apps/web/src/landing.json`: `title`, `tagline`, `callToAction`, and `footerNote`. Edit those strings without adding HTML, keep the file valid JSON, then rebuild the web image:

```sh
docker compose up -d --build web
```

Source edits are copied into the server build and do not update an already-built container. The landing page is off by default. To show it, set `LANDING_ENABLED=true` in `.env`, recreate the API and web services, then use **Administration > Site settings** if an administrator previously disabled it. Setting the variable to `false` forces the page off regardless of the administrator setting.

## HTTPS

The default listener is loopback-only. For remote access, put a trusted HTTPS reverse proxy in front of Hopya and set `APP_URL` to the exact external origin, such as `https://tasks.example.com`. Forward the complete site, including `/api` and `/health`, and preserve `Host` and `Origin`.

Do not publish ports 3333 or 4321. The internal Nginx replaces forwarded client-address headers before requests reach AdonisJS. If another proxy sits in front, trust only that proxy's exact address when configuring real-IP handling; never trust all sources or a broad shared subnet.

Secure cookies and same-origin mutation checks depend on an accurate `APP_URL`. Do not disable origin checks to work around a proxy error.

## Attachments

The default `STORAGE_DRIVER=filesystem` stores private objects under `./data`. For S3-compatible storage, configure a private bucket and least-privilege credentials with `S3_BUCKET`, `S3_REGION`, optional `S3_ENDPOINT`, and the required `AWS_*` values.

Changing storage backends is not a data migration. Transfer and verify existing objects before changing configuration. Remote object versions and lifecycle rules need a separate backup policy.

## Password Recovery

Set both `SMTP_URL` and `SMTP_FROM` to enable local password recovery. Use a verified TLS SMTP relay and an authorized sender. Reset links expire after 30 minutes and revoke existing Hopya sessions and API tokens when consumed.

The MCP SSE endpoint is disabled until a site administrator enables it. If exposed through a reverse proxy, preserve streaming responses without buffering, keep `Authorization` headers on both GET and POST, enforce HTTPS, and apply proxy connection limits and timeouts compatible with Hopya's 30-minute session lifetime. Do not add tokens to URLs or proxy access logs.

Compose passes `HOPYA_MCP_ALLOW_WRITES` to the API with a `false` default. Set it to `true` in `.env` and recreate the API only when every connected MCP host enforces explicit human approval for each mutation. SSE enablement remains a persisted administrator setting, not an environment override.

Test delivery, sender authorization, spam handling, expiry, and recovery with your actual mail provider. Hopya never logs or displays reset tokens as a fallback.

## OIDC And AI

OIDC works with standards-compliant providers supporting Authorization Code flow, PKCE S256, and `client_secret_post`. Follow the [OIDC setup guide](oidc-setup.md). Keep `OIDC_AUTO_PROVISION=false` unless automatic creation of verified non-admin identities is intentional.

The AI assistant is disabled when `AI_PROVIDER` is empty. Enabling it can send authorized workspace context to the selected provider. Review provider retention, billing, and privacy terms before configuration. AI output remains an untrusted proposal and cannot directly mutate tasks.

## Backup And Restore

A workspace export is portable task data, not a full backup. SQLite deployments need the complete `./data` directory. PostgreSQL deployments need a consistent database dump plus `./data` when filesystem attachments are enabled. Both require the original `.env`.

Create a cold backup:

```sh
mkdir -p backups
chmod 700 backups
umask 077
docker compose stop proxy api
tar -czf backups/hopya-data.tgz -C data .
tar -tzf backups/hopya-data.tgz
sha256sum backups/hopya-data.tgz
docker compose up -d --wait
```

Store the archive and an encrypted `.env` backup off-host. For S3 storage, back up remote objects at the same logical point as the database.

For PostgreSQL, stop API writes and use the server's supported `pg_dump`/`pg_restore` workflow instead of treating its data volume as a portable archive. Verify the dump before restarting Hopya and back up filesystem or S3 objects at the same logical point.

Restore into a new directory rather than overwriting the old one:

```sh
docker compose stop proxy api
mkdir -p restore-data
chmod 700 restore-data
tar --no-same-owner -xzf backups/hopya-data.tgz -C restore-data
```

Create an ignored `compose.restore.yaml`:

```yaml
services:
  api:
    volumes:
      - ./restore-data:/data
```

Then validate and start with both files:

```sh
docker compose -f docker-compose.yml -f compose.restore.yaml config --quiet
docker compose -f docker-compose.yml -f compose.restore.yaml up -d --wait
```

Verify login, workspace counts, task writes, permissions, and private attachment downloads before retiring the old volume. Restoring an old database can revive credentials valid at backup time; revoke affected access again before reopening the instance.

## Upgrades

1. Read the release notes and take a verified cold backup.
2. Keep the existing `.env`, especially `APP_KEY`.
3. Update the checkout and run `docker compose build --pull`.
4. Start with `docker compose up -d --wait`.
5. Verify health, login, task writes, and attachments.

Migrations run automatically when the API starts. Keep the selected database and `./data` attachment storage in place during upgrades; the removed pre-Lucid SQL migration runner is not an upgrade path for older databases.

## Troubleshooting

Start with:

```sh
docker compose ps
docker compose logs --tail=100 api web proxy
```

`/health` checks API readiness. Monitor disk capacity, backup age, container health, and TLS expiry. Do not paste `.env`, cookies, authorization headers, full Compose output, or unredacted provider errors into public issues.

Developers can run `npm run test:deployment` to build and verify an isolated Docker instance. It creates uniquely labeled temporary resources and does not use the operator's `.env`.
