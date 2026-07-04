# Docker Image Publishing (CI)

## Purpose

`.github/workflows/docker-publish.yml` builds and publishes the production Docker image (see the `Dockerfile` at the repo root) to GitHub Container Registry (GHCR) as `ghcr.io/<owner>/<repo>`, for both `linux/amd64` and `linux/arm64`, without requiring anyone to build locally or push manually.

## Triggers

| Event | Effect |
|---|---|
| Push to `main` | Rebuilds and republishes the `latest`/`edge` tag |
| Push of a `v*` tag (e.g. `v1.2.0`) | Publishes semver tags (`1.2.0`, `1.2`) |
| Pull request targeting `main` | Runs the test suite and a build-only validation on both architectures — never touches GHCR |
| Daily schedule (`0 3 * * *`) | Rebuilds on top of the latest `node:22-bookworm-slim` base image, so security patches land even with no app changes |
| `workflow_dispatch` | Manual run from the Actions tab |

## Test gate

Every trigger — including PRs — runs the `test` job first: `npm ci` + `npm test` (the Jest suite in `server/tests/`) on `ubuntu-24.04`. Both `build` and `pr_test_build` declare `needs: test`, so a failing test suite blocks any image from being built at all, published or not. `merge` in turn depends on `build`, so the whole publish path is transitively gated on tests passing.

## Why native ARM runners instead of QEMU

Building `linux/arm64` on an `amd64` GitHub-hosted runner normally means emulating ARM under QEMU via Buildx — it works, but `better-sqlite3`'s native module compile (`python3 make g++`, see `Dockerfile` stage `server-deps`) is CPU-heavy and QEMU emulation makes it dramatically slower, often the single biggest contributor to build time. GitHub now offers native `ubuntu-24.04-arm` runners, so the `arm64` leg of the matrix builds on real ARM hardware instead of emulating it.

## Why split build + merge jobs

Each matrix leg (`amd64` on `ubuntu-24.04`, `arm64` on `ubuntu-24.04-arm`) builds and pushes its own image **by digest only** — no tag, so nothing pullable exists yet from either leg alone. The digest is exported as a build artifact (`digests-amd64`, `digests-arm64`).

A separate `merge` job then downloads both digest artifacts and runs `docker buildx imagetools create` to assemble a single multi-arch manifest list pointing at both digests, applying the real tags (`latest`, `edge`, semver) only at that point. This is the standard Buildx pattern for matrix-parallel multi-arch builds — it avoids one platform's build clobbering the tag before the other finishes, and avoids running both platforms in a single job (which would serialize them, or need QEMU for one anyway).

## Image tags

Tag rules come from `docker/metadata-action` in the `merge` job:

| Git ref | Resulting tag(s) |
|---|---|
| Push to `main` | `latest`, `edge` |
| Scheduled run | `edge` |
| Tag `v1.2.0` | `1.2.0`, `1.2` |

## Jobs

```
test (runs on every trigger)
  1. Checkout
  2. Set up Node.js 22
  3. npm ci
  4. npm test — Jest suite in server/tests/

build (needs: test; matrix: amd64, arm64; skipped on pull_request)
  1. Checkout
  2. Set up Buildx
  3. Log in to GHCR (GITHUB_TOKEN — no PAT needed)
  4. Build + push image by digest (no tag yet)
  5. Export the digest to /tmp/digests and upload as an artifact

merge (needs: build; skipped whenever build is skipped, e.g. on pull_request)
  1. Download both digest artifacts into /tmp/digests
  2. Set up Buildx, log in to GHCR
  3. Compute tags via docker/metadata-action
  4. docker buildx imagetools create — assembles the multi-arch manifest list, applies tags, pushes
  5. docker buildx imagetools inspect — sanity-check the pushed manifest

pr_test_build (needs: test; matrix: amd64, arm64; only on pull_request)
  1. Checkout
  2. Set up Buildx
  3. Build for each platform with push: false — validates the Dockerfile builds cleanly on both architectures, publishes nothing, needs no GHCR credentials
```

## Permissions

`permissions: packages: write` on the workflow is what lets the built-in `GITHUB_TOKEN` push to GHCR — no separate PAT or secret is configured. `contents: read` is the default least-privilege for checkout.

## One-time manual step: GHCR package visibility

**GHCR packages are private by default on first push, even from a public repository.** After the first successful run, anyone trying to `docker pull ghcr.io/<owner>/<repo>` will get a permission error until visibility is fixed manually — this can't be set from the workflow itself.

Fix it once, after the first push completes:

1. Go to `github.com/users/<owner>/packages` (or the organization's Packages tab).
2. Open the `<repo>` package → **Package settings**.
3. Either set **Visibility** to Public, or link the package to the repository (**Manage Actions access** / connect repository) so it inherits the repo's visibility.

## Local equivalent

This workflow builds the same `Dockerfile` described in the [README](../README.md#installation-production) and used by `docker-compose.yml` — it doesn't change what gets built, only automates building it for two architectures and publishing it centrally instead of every user building it locally with `docker compose up --build`.
