# Authentication, API Tokens, and Roles (design spec)

Status: implemented on the `feat/auth-rbac` branch. Live: the server and RBAC middleware, API tokens (device and display), the SSO forward-auth header, the dashboard IP allowlist, and the full web client (login, first-run setup, forced change password, a My Account page, and admin Users/Tokens panels). WebAuthn passkeys are implemented (register from My Account, sign in from the login screen) via `@simplewebauthn`, pending validation against a physical authenticator. Multi-factor auth is implemented: TOTP authenticator apps (hand-rolled, verified against the RFC 6238 vectors) plus single-use recovery codes, a two-step password login, and a global `require_mfa` policy that forces enrollment. Authentication is mandatory on this build (see below). Covered by `server/tests/auth.test.js` and `server/tests/mfa.test.js`.

Print Farm Manager has historically shipped with no authentication: the API is open on the LAN and any device that can reach the server can drive printers. This is fine for an air gapped farm, but once the app is exposed through a reverse proxy (or an operator wants per person accountability and roles), it needs real access control. This feature adds authentication, API tokens, and role based access control (RBAC) without changing the project's minimalism: no new runtime dependencies, hashing via Node's built in `crypto`, storage in the existing SQLite database.

## Authentication is mandatory

This build requires authentication: it is always on and cannot be turned off. The `auth_enabled` setting is retained for compatibility but is not writable and no longer gates anything. A fresh or migrated install with no users is stepped through creating the primary admin in a browser setup wizard; `npm run set-password <username>` is the headless equivalent. `GET /api/health` and the auth endpoints (login, setup, me) are always reachable so you can sign in.

Note: this deliberately departs from the backward-compatible, off-by-default posture an upstream contribution would need (existing installs would suddenly require a login and setup on `git pull`). It is a deployment choice for this fork; an upstream version would likely keep auth opt-in.

## Identities

Three ways a request can be authenticated:

1. **Session cookie** (human, web UI). `POST /api/auth/login` verifies a username and password and sets an `httpOnly`, `SameSite=Lax`, `Secure` cookie holding an opaque session token. The token is stored hashed in `sessions` with an expiry.
2. **API token** (machines, e.g. the CYD wall box). `Authorization: Bearer <token>` (or `X-API-Key: <token>`). Tokens are random, shown once at creation, stored only as a hash, and carry a role.
3. **Dashboard IP allowlist** (appliance displays). A request whose real client IP is in `dashboard_ip_allowlist` may read the dashboard with no credentials. This is read only and scoped to the dashboard endpoints only (see below).

## Roles

| Role | Intent | Can |
|---|---|---|
| `admin` | Owns the install | Everything, including managing users, API tokens, printers and their config, models, groups, settings, and backup or restore |
| `operator` | Runs the farm day to day | All reads, plus operator actions (set-ready, set-ready-batch, mark-job-failure, recommission, complete-and-decommission, decommission, printer notes, link-job) and managing projects, parts, and G-codes |
| `viewer` | Looks, does not touch | Read only (GET) |
| `device` | Scoped machine token (the CYD) | A fixed allowlist: `GET /api/printers`, `GET /api/dashboard`, `POST /api/printers/:id/set-ready`, `POST /api/printers/:id/mark-job-failure`. Nothing else. May be bound to specific printers |
| `display` | Read-only viewport token (an Apple TV or Android app adopted as a device, not a user) | A fixed allowlist: `GET /api/dashboard` and `GET /api/printers`. Nothing else |

`admin` and `operator` and `viewer` form a hierarchy (admin > operator > viewer). `device` and `display` are token-only roles, not in the hierarchy: each is an explicit endpoint allowlist, so a leaked token cannot do anything but its narrow job. A `device` token may additionally carry a `printer_ids` binding (a JSON array); when set, its per-printer actions are restricted to those printers (the ones next to that CYD), so a leaked device token cannot touch the rest of the fleet. `display` is the token equivalent of the dashboard IP allowlist, for a native app rather than a browser.

### Default enforcement

When `auth_enabled = 1`, the middleware applies these defaults, which specific routes may tighten:

- `GET /api/*` requires at least `viewer`.
- `POST` / `PUT` / `DELETE` on `/api/*` requires at least `operator`.
- Admin only areas require `admin`: `/api/settings`, `/api/models`, `/api/groups`, `/api/backup`, user and token management, and printer create / update / delete (printer config is admin, but the per printer operator actions above are `operator`).

## The dashboard IP allowlist (and the reverse proxy problem)

Appliance browsers (smart TVs, set top boxes) cannot log in. `dashboard_ip_allowlist` is a comma separated list of IPs and CIDRs (for example `192.168.15.50, 192.168.20.0/24`). A request from a matching client IP is treated as an implicit dashboard only viewer: it may call the dashboard endpoints and nothing else, with no login.

Endpoints reachable this way are limited to exactly what the dashboard page loads: `GET /api/dashboard` (and the static client assets). Every other endpoint still requires a real identity.

**Reverse proxy caveat.** Behind Traefik the TCP peer is always the proxy, so the socket IP is useless for allowlisting. The server reads the client IP from `X-Forwarded-For`, but only trusts that header when the immediate peer is a configured trusted proxy. `trusted_proxies` (setting, comma separated IPs or CIDRs, for example the Traefik IP `192.168.15.30`) drives Express's `trust proxy`. If `trusted_proxies` is empty, XFF is ignored and the raw socket IP is used (correct for a direct LAN deployment with no proxy). This prevents a client from spoofing `X-Forwarded-For` to slip into the allowlist.

## Endpoints (planned)

| Method | Path | Role | Purpose |
|---|---|---|---|
| POST | `/api/auth/login` | public | Username plus password, sets session cookie |
| POST | `/api/auth/logout` | any session | Clears the current session |
| GET | `/api/auth/me` | any identity | Returns the current identity and role, or `{ authenticated: false }` |
| POST | `/api/auth/setup` | public, only when zero users exist | Creates the first admin (first run bootstrap) |
| GET | `/api/users` | admin | List users |
| POST | `/api/users` | admin | Create a user (username, password, role) |
| PUT | `/api/users/:id` | admin | Update role, active flag, or password (COALESCE partial update) |
| DELETE | `/api/users/:id` | admin | Delete a user (never the last admin) |
| GET | `/api/tokens` | admin | List API tokens (never the secret, only prefix plus metadata) |
| POST | `/api/tokens` | admin | Create a token, returns the secret once |
| DELETE | `/api/tokens/:id` | admin | Revoke a token |

## Schema (additive, `CREATE TABLE IF NOT EXISTS`)

- `users`: `id`, `username` UNIQUE, `password_hash`, `password_salt`, `role`, `is_active` (0/1), `created_at`, `last_login_at`.
- `api_tokens`: `id`, `name`, `token_hash`, `token_prefix` (first 8 chars, for display), `role`, `created_at`, `last_used_at`, `revoked` (0/1), `created_by` (user id).
- `sessions`: `id`, `user_id`, `token_hash`, `created_at`, `expires_at`, `last_seen_at`.

All timestamps are epoch milliseconds (INTEGER). Booleans are 0/1. Passwords use `crypto.scryptSync` with a per user random salt. Tokens and session tokens are `crypto.randomBytes` hashed with SHA-256 before storage.

## Backup

`users` and `api_tokens` (both storing only hashes, never plaintext) and the new settings (`auth_enabled`, `dashboard_ip_allowlist`, `trusted_proxies`) are added to the backup export and restore, and to the backup round trip test, so an admin's accounts and the CYD's token survive a restore. `sessions` are ephemeral and are not backed up.

## Client

- On load the SPA calls `GET /api/auth/me`. If auth is enabled and the response is unauthenticated, it shows a login page (dark theme, inline styles, matching the existing pages). The dashboard route is reachable without login so an allowlisted appliance renders it directly.
- Settings gains admin only panels for Users and API Tokens (create shows the secret once with a copy control).
- The nav and per page actions are gated by the current role: a viewer sees read only, an operator does not see admin panels, and so on.
- A global 401 handler on user initiated mutations sends the user to the login page.

## Testing

Supertest suites cover: login success and failure, session and bearer identity resolution, the `auth_enabled` off pass through, role enforcement on a representative endpoint per role, the `device` token allowlist (allowed and denied endpoints), the dashboard IP allowlist with and without a trusted proxy header, user and token CRUD, and the backup round trip of the new tables. Password and token hashing are unit tested. No mocks of the auth module itself.
