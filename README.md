# samplevault

Sample host, audition UI, and ephemeral pack builder for [Strudel](https://strudel.cc).
Companion to **patternvault** — patternvault stores the patterns, samplevault stores
the sounds they reach for.

Indexes your own folders *and* public sample repos, proxying the remote ones so a
pack can freely mix a vocal one-shot off your NAS with a kick from Dirt-Samples.

Two containers:

| Service | Image | Port | Job |
| --- | --- | --- | --- |
| `samplevault-web` | `ghcr.io/therebelrobot/samplevault-web` | 3011 | serves audio, the manifest, and the UI |
| `samplevault-api` | `ghcr.io/therebelrobot/samplevault` | 3012 (internal) | scans folders, indexes remote sources, proxies remote audio, writes `strudel.json`, validates packs |

### Where things live

| | Default | Why |
| --- | --- | --- |
| **Library** | `SAMPLES_DIR` | your audio; read-only as far as the index is concerned |
| **Cache** | `CACHE_DIR`, defaults to `<SAMPLES_DIR>/.cache` | remote audio and source indexes — the part that grows, so it stays on the samples volume |
| **UI store** | `DB_PATH`, defaults to `/data/samplevault.json` | packs, views, and name overrides; a few KB, mounted from next to `docker-compose.yml` |

**There is no `strudel.json` on disk.** Manifests are rendered from the live
index on every request, so nothing goes stale and the library never gets written
into. `.cache/` is the only thing samplevault puts on the samples volume, and
`CACHE_DIR` moves it if you want it elsewhere.

---

## Quickstart

Nothing to build — both images are published on GHCR. Make a directory, drop in
this `docker-compose.yml`, and go:

```yaml
services:
  samplevault-api:
    image: ghcr.io/therebelrobot/samplevault:latest
    container_name: samplevault-api
    restart: unless-stopped
    environment:
      BASE_URL: ${BASE_URL:-http://localhost:3011/samples/}
    volumes:
      - ./samples:/srv/samples
      - ./data:/data          # UI store — small, stays next to this file

  samplevault-web:
    image: ghcr.io/therebelrobot/samplevault-web:latest
    container_name: samplevault-web
    restart: unless-stopped
    ports:
      - "3011:80"
    volumes:
      - ./samples:/srv/samples:ro
    depends_on:
      - samplevault-api
```

```bash
mkdir -p samples/vox            # one folder per sound
cp ~/takes/*.wav samples/vox/
docker compose up -d
```

Open <http://localhost:3011/samples/ui/>, then in Strudel:

```javascript
samples('http://localhost:3011/samples/strudel.json')     // whole library
samples('http://localhost:3011/samples/m/live-set.json')  // a saved view
s("vox:0 vox:1")
```

`BASE_URL` must match the URL a browser will actually use, with a trailing
slash — it is written into the manifest as `_base`. Put it in a `.env` file
next to the compose file when you move off localhost:

```
BASE_URL=https://strudel.example.com/samples/
SAMPLES_DIR=/mnt/media/samples
```

### API only

If you have your own static front end and just want the indexer and proxy:

```bash
docker run -d --name samplevault-api \
  -e BASE_URL=https://strudel.example.com/samples/ \
  -v "$PWD/samples:/srv/samples" \
  -p 3012:3012 \
  ghcr.io/therebelrobot/samplevault:latest
```

Serve the samples directory yourself at `/samples/`, and reverse-proxy
`/samples/api/` and `/samples/remote/` to port 3012.

### Putting it behind Nginx Proxy Manager

Add a **custom location** on the proxy host that already serves your Strudel
instance:

- Location: `/samples/`
- Forward to: `<docker-host>:3011`

The container also serves everything under `/samples/`, so the prefix passes
through with no rewrite. Because the samples share an origin with the Strudel
UI, whatever auth already protects that host covers them too, and **no CORS
configuration is needed**.

Visiting `/samples`, `/samples/`, or `/samples/ui` (no trailing slash) redirects
to `/samples/ui/`. nginx prefix locations only match *with* the slash, so
without those redirects the slashless URLs fall through to the catch-all and
404 — which is what happens if you deploy an older `samplevault-web` image.

> If the host is behind basic auth, verify the access list actually reaches the
> new path — `curl -o /dev/null -w '%{http_code}\n' https://strudel.example.com/samples/strudel.json`
> should return `401`. A `200` means auth was only applied to `/`, and you need
> `auth_basic` + `auth_basic_user_file` in the custom location's config.

---

## Naming rule

A directory containing audio becomes one sound. Its files are the indexed
variants, in **natural sort order**.

```
samples/vox/oh_1.wav        →  s("vox:0")
samples/vox/oh_2.wav        →  s("vox:1")
samples/vox/oh_10.wav       →  s("vox:2")
samples/fx/breath/a.wav     →  s("fx_breath:0")
samples/loose.wav           →  ignored (logged as a warning)
```

- Natural sort means `oh_2` lands at `:1` and `oh_10` at `:2`. Plain alphabetical
  sort would have reversed them and silently renumbered your takes.
- A file at the root is skipped — a sound needs its own folder.

`strudel.json` is rewritten within `DEBOUNCE_MS` of any change under the samples
directory. You never regenerate it by hand.

### Deep libraries

Mini-notation only accepts `[A-Za-z0-9_]`, and commercial libraries nest deeply
with spaces and repeated words. Names are built from the last `NAME_DEPTH`
segments (default **2**), split into tokens, deduplicated, and rejoined:

```
Splice/sounds/packs/World Class Percussion by Josh Mellinger/
  World_Class_Percussion/WCP_Riq/WCP_Riq_One_Shots/
                            →  s("WCP_Riq_One_Shots:0")
```

Set `NAME_DEPTH=0` to use the whole path, or `1` for just the leaf folder.
Shortening can make two folders collide; the second gets `_2` appended rather
than being dropped, and the rename is logged.

### names.json

For anything you want named by hand, drop a `names.json` in the samples
directory mapping the folder path to the name you want:

```json
{
  "Splice/sounds/packs/World Class Percussion by Josh Mellinger/World_Class_Percussion/WCP_Riq/WCP_Riq_One_Shots": "riq",
  "Splice/sounds/packs/World Class Percussion by Josh Mellinger/World_Class_Percussion/WCP_Steel_Drum/WCP_Steel_Drum_One_Shots": "steel"
}
```

```javascript
s("riq:3 steel:0")
```

Overrides win over generated names. Anything not listed still gets a generated
one, so you only name the folders you actually reach for. The startup log prints
the first few generated names so you know what to paste in.

---

## The UI

`/samples/ui/`

**Auditioning.** Click a file to decode and play it. The waveform (48 peak
buckets) and duration fill in after first playback, so the library develops as
you work rather than decoding everything on load.

Keyboard: `↑`/`↓` or `j`/`k` to move, `space` to play, `a` to add to the pack.

**Packs.** Selected files stack into a splice strip along the bottom, labeled
`:0 :1 :2` in the order they will be indexed. `◀ ▶` reorder, `▸` auditions one,
**Play through** plays the whole splice back to back. Packs are references, never
copies — remixing costs no disk and a pack can pull across folders freely.

### Views

The whole library in one manifest gets noisy once you have a commercial pack
indexed. Star sounds in the rail, give the selection a name, and **Save
starred** — that view is served at `/samples/m/<name>.json` and contains only
those sounds. **Copy manifest URL** gives you the `samples(...)` line for
whichever view is selected.

Views are references, not copies. Rename a folder and the view quietly drops the
sound it can no longer find rather than emitting a broken entry.

### Renaming

Name overrides live in the UI store, keyed by folder path — so a generated
`WCP_Riq_One_Shots` can become `riq` without touching the library. `PUT
/api/names` takes the whole map; the index rebuilds immediately.

Two ways out of the pack builder:

| | What happens | Persistence |
| --- | --- | --- |
| **Copy snippet** | `samples({ name: [...] }, base)` on your clipboard | localStorage only — truly ephemeral |
| **Publish** | written to the UI store, merged into every manifest | permanent; `s("mix1:0")` works in any pattern |

Publish hides itself when the API is unreachable. `READ_ONLY=1` serves manifests
and audio normally but rejects every write, which is the mode to use if you ever
expose an instance beyond your own network.


---

## Remote sources

Public sample repos are added and managed in the UI — **Remote repos…** at the
bottom of the sidebar. Fill in the form, press **Preview**, and play the sounds
before anything is committed; preview audio streams through this server's proxy
without entering the manifest. Press **Add to library** when it sounds right.

Two kinds:

| Kind | Needs | Notes |
| --- | --- | --- |
| **GitHub repo** | `owner/name` and a ref | ref takes a branch, tag, **or commit SHA**; a subfolder narrows a large repo |
| **Published strudel.json** | a URL | works against another samplevault instance |

Every source gets a name prefix (default `<id>_`) so remote sounds cannot shadow
yours. Preview flags any collisions before you commit, and the indexer skips a
colliding remote name rather than overwriting a local one.

Remote sounds land in the manifest with paths rewritten to `remote/<id>/<path>` —
relative to `_base`, so **everything stays on your origin**. One host, one auth
boundary, no CORS, and it works for upstreams that send no CORS headers at all.

```javascript
samples('https://example.com/samples/strudel.json')
s("vox:0 dirt_bd:2")     // your voice, their kick
```

Sources live in the UI store alongside packs and views. A `sources.json` from an
older install is imported once on first boot, after which the UI owns them.

**Caching.** A remote index is fetched once and cached for `REMOTE_TTL` seconds
(default 24h). Audio files cache to disk on first play, so auditioning does not
re-hit upstream and a pack keeps working if the upstream repo disappears.
**Rescan library** (top of the page) forces a re-index: it re-walks local files
and, ignoring the TTL, re-fetches every remote source index. Local files are
also re-scanned automatically on change (see `WATCH` below); this button is
for triggering it on demand, e.g. right after adding samples, without
restarting the server. The remote cache lives in `CACHE_DIR` and grows
unbounded — delete it whenever you want the space back.

**Pin your refs.** A branch name means upstream can change the audio under a
published pack; a commit SHA means it cannot. Worth doing for anything you
release.

**Rate limits.** The GitHub tree API allows 60 requests/hr unauthenticated. With
a 24h index cache you will not notice, but set `GITHUB_TOKEN` if you are adding
several repos in one sitting — the error message tells you when you have hit it.

**Licensing is yours to check.** samplevault will index anything public; it does
not read licenses.

---

## Configuration

Environment variables on `samplevault-api`:

| Variable | Default | Notes |
| --- | --- | --- |
| `SAMPLES_DIR` | `/srv/samples` | the library; bind-mount over it |
| `DB_PATH` | `/data/samplevault.json` | UI store: packs, views, names |
| `CACHE_DIR` | `<SAMPLES_DIR>/.cache` | remote audio and index cache |
| `BASE_URL` | — | public URL with trailing slash; becomes `_base` in the manifest |
| `NAME_SEP` | `_` | joins name tokens |
| `NAME_DEPTH` | `2` | trailing path segments used for a name; `0` uses the whole path |
| `EXTS` | `wav,mp3,ogg` | comma-separated, no dots needed |
| `PORT` | `3012` | API port, internal to the compose network |
| `WATCH` | `1` | `0` builds once and exits the watcher |
| `DEBOUNCE_MS` | `500` | quiet period after a file event |
| `SOURCES_FILE` | next to `DB_PATH` | legacy seed file, imported into the store on first boot |
| `REMOTE_TTL` | `86400` | seconds before a remote index is re-fetched |
| `GITHUB_TOKEN` | — | raises the tree API limit from 60/hr to 5000/hr |
| `READ_ONLY` | `0` | `1` serves manifests and audio but rejects writes |

On the host, `SAMPLES_DIR` in `.env` sets which directory gets mounted
(defaults to `./samples`) — useful if your audio lives on an SMB share.

---

## API

Reached at `/samples/api/` through nginx.

| Route | Does |
| --- | --- |
| `GET /api/manifest` | the whole library, rendered on request |
| `GET /api/manifest/:view` | one saved view |
| `GET /api/health` | `{ ok, base, readOnly, builtAt }` |
| `GET/PUT /api/views`, `DELETE /api/views/:name` | saved views |
| `GET/PUT /api/names` | folder-path to sound-name overrides |
| `GET/PUT /api/sources`, `DELETE /api/sources/:id` | remote repo definitions |
| `POST /api/sources/preview` | resolve a candidate repo without saving it |
| `GET /api/sources` | resolved remote sources and the sound names each contributed |
| `POST /api/sources/refresh` | rescans local files and re-fetches every remote index, ignoring the TTL |
| `GET /api/remote/:id/*` | proxies one remote file, caching it to disk |
| `GET /api/packs` | published packs |
| `PUT /api/packs` | replaces all packs (validated), rewrites the manifest |
| `DELETE /api/packs/:name` | removes one pack, rewrites the manifest |

A pack is rejected with `422` if its name is outside `[A-Za-z0-9_]`, collides
with a folder-derived sound, is listed twice, has no files, or references a file
that is not in the library. Validation runs before the write, so `strudel.json`
can never point at a missing file.

```bash
curl -X PUT https://strudel.example.com/samples/api/packs \
  -u user:pass -H 'content-type: application/json' \
  -d '[{"name":"mix1","files":["vox/oh_10.wav","fx/breath/a.wav"]}]'
```

---

## Development

```bash
npm install
npm run dev        # seeds .env from .env.example on first run, then tsx watch
npm run typecheck
npm run build      # esbuild → dist/server.js, single file
```

`npm run dev` runs the whole app in one process — the API plus the UI and audio
files, on the same URL shape nginx uses in production. No containers needed:

```bash
npm install
npm run dev
open http://localhost:3012/samples/ui/
```

In Strudel, point at the dev server directly:

```javascript
samples('http://localhost:3012/samples/strudel.json')
```

That static serving is what `SERVE_STATIC` controls (on by default). In the
deployed stack nginx matches those paths first, so it never runs there.

Copy `.env.example` to `.env` (or let `npm run dev` do it) and set at minimum:

| Variable | For local dev |
| --- | --- |
| `SAMPLES_DIR` | `./samples` — the container default is `/srv/samples`, which you almost certainly cannot write on your own machine |
| `DB_PATH` | `./data/samplevault.json` |
| `BASE_URL` | `http://localhost:3012/samples/` — the dev port, not 3011 |

`.env` is gitignored; `.env.example` is the committed template.

Two images ship from this repo:

| Script | Builds |
| --- | --- |
| `docker:build` / `docker:push` | `samplevault` — the API from `Dockerfile` |
| `docker:build:web` / `docker:push:web` | `samplevault-web` — nginx with `ui/` and `nginx.conf` baked in, from `Dockerfile.web` |

To develop the UI against published images, uncomment the two bind mounts under
`samplevault-web` in `docker-compose.yml` — they override the baked-in copies.

Also: `docker:run`, `release:patch|minor|major`, `release:tags`.

### Releasing

CI runs typecheck, bundle, a UI parse check, and both image builds on every push
and PR.

Publishing is automatic — `.github/workflows/publish.yml` builds both images for
`linux/amd64` and `linux/arm64` and pushes to GHCR:

| Trigger | Tags produced |
| --- | --- |
| push to `main` | `latest`, `sha-<short>` |
| push of a `v*` tag | `1.2.3`, `1.2`, `sha-<short>` |
| manual dispatch | same as the branch it runs on |

So a release is just:

```bash
npm run release:patch      # npm version + git push --tags
```

The workflow authenticates with the built-in `GITHUB_TOKEN`; no PAT and no repo
secrets to configure. It emits max-mode provenance and an SBOM, and pushes a
signed build attestation to the registry, verifiable with:

```bash
gh attestation verify oci://ghcr.io/therebelrobot/samplevault:latest --owner therebelrobot
```

Actions are referenced by major tag with Dependabot watching them. Pin them to
commit SHAs if you want the stronger supply-chain guarantee — Dependabot updates
SHA-pinned actions too.

**First push:** GHCR packages start private. After the first successful run, set
both packages to public in the repo's Packages settings, or the compose file in
the Quickstart will fail to pull for anyone else.

---

## Gotchas

**Cache headers are split on purpose.** `strudel.json` is `no-cache`; audio is
`max-age=3600`. If you replace a take under the same filename within that hour,
append `?v=2` to the manifest URL to force a reload — Strudel lazy-loads sample
maps and browsers cache them hard.

**`node:24-alpine` is pinned, not floating.** Watchtower is enabled on these
containers and Node should not move under a running service. Bump it deliberately.

**The URL path stays `/samples/`, not `/samplevault/`.** `_base` is baked into
every generated manifest, so changing the route breaks patterns already loading
from it. To change it anyway: the `location` blocks in `nginx.conf`, `BASE_URL`
in `docker-compose.yml`, and the NPM custom location.

**Renaming a folder changes its sound name.** Patterns referencing the old name
break. Pin the names you use in `names.json` and the folder can move freely
underneath it.

**Remote audio has first-play latency.** A cache miss is a round trip to
upstream, so the first audition of a remote sound is slower than a local one.
Every play after that is served off disk.

**Manifests exist only while the service runs.** They are generated per request,
so a stopped container means patterns cannot load samples. That is the trade for
never having a stale file on disk.

---

## License

Unlicense — public domain.
