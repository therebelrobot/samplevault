import { mkdir } from 'node:fs/promises'
import { watch } from 'node:fs'
import { join, resolve } from 'node:path'
import { Db } from './db'
import { folders, scan, warnings, type Config, type Sounds } from './scan'
import { startServer } from './server'
import { loadSourceDefs, remoteWarnings, resolveSources, type RemoteSource } from './sources'

const root = resolve(process.env.SAMPLES_DIR ?? '/srv/samples')

const cfg: Config = {
  root,
  // Cache lives with the library by default: it is the part that grows.
  cacheDir: resolve(process.env.CACHE_DIR ?? join(root, '.cache')),
  baseUrl: process.env.BASE_URL ?? '',
  nameSep: process.env.NAME_SEP ?? '_',
  exts: (process.env.EXTS ?? 'wav,mp3,ogg')
    .split(',')
    .map((e) => '.' + e.trim().toLowerCase().replace(/^\./, '')),
  nameDepth: Number(process.env.NAME_DEPTH ?? 2),
}

const PORT = Number(process.env.PORT ?? 3012)
const READ_ONLY = process.env.READ_ONLY === '1'
const WATCH = process.env.WATCH !== '0'
const DEBOUNCE_MS = Number(process.env.DEBOUNCE_MS ?? 500)
const DB_PATH = resolve(process.env.DB_PATH ?? '/data/samplevault.json')
const SERVE_STATIC = process.env.SERVE_STATIC !== '0'
const UI_DIR = resolve(process.env.UI_DIR ?? 'ui')
const SOURCES_FILE = process.env.SOURCES_FILE ?? join(DB_PATH, '..', 'sources.json')
const REMOTE_TTL_MS = Number(process.env.REMOTE_TTL ?? 86400) * 1000

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a)

for (const [label, dir] of [
  ['SAMPLES_DIR', cfg.root],
  ['CACHE_DIR', cfg.cacheDir],
  ['DB_PATH', join(DB_PATH, '..')],
] as const) {
  try {
    await mkdir(dir, { recursive: true })
  } catch (err) {
    console.error(`samplevault: cannot use ${label} "${dir}" — ${(err as Error).message}`)
    console.error('Point it somewhere writable (see .env.example).')
    process.exit(1)
  }
}

if (!cfg.baseUrl) {
  log('WARN BASE_URL is unset — manifests will have an empty _base and paths will resolve relative to the pattern')
}

const db = new Db(DB_PATH)
await db.load()

/** The live index. Manifests are rendered from this per request, never stored. */
export interface Index {
  sounds: Sounds
  remotes: RemoteSource[]
  /** Candidate sources resolved for auditioning but not yet added. */
  previews: RemoteSource[]
  builtAt: number
}
const index: Index = { sounds: {}, remotes: [], previews: [], builtAt: 0 }

// One-time import: sources used to live in a file. Seed the store from it so
// existing installs keep working, then the UI owns them.
if (db.sources.length === 0) {
  const seeded = await loadSourceDefs(SOURCES_FILE)
  if (seeded.length) {
    await db.update((d) => {
      d.sources = seeded
    })
    log(`imported ${seeded.length} source(s) from ${SOURCES_FILE} into the store`)
  }
}

let queue: Promise<void> = Promise.resolve()
const reindex = (force = false): Promise<void> => {
  queue = queue.then(() => build(force)).catch((err: Error) => log('ERROR', err.message))
  return queue
}

async function build(force: boolean): Promise<void> {
  const local = await scan(cfg, db.names)
  for (const w of warnings) log('WARN', w)

  const resolved = await resolveSources(cfg, db.sources, REMOTE_TTL_MS, force)
  for (const w of remoteWarnings) log('WARN', w)

  const merged: Sounds = { ...local }
  for (const source of resolved) {
    for (const [name, files] of Object.entries(source.sounds)) {
      if (merged[name]) {
        log('WARN', `"${name}" from source "${source.def.id}" collides with an existing sound - skipped`)
        continue
      }
      merged[name] = files
    }
  }

  index.sounds = merged
  index.remotes = resolved
  index.builtAt = Date.now()

  const remoteCount = Object.keys(merged).length - Object.keys(local).length
  log(`indexed ${Object.keys(local).length} local + ${remoteCount} remote sound(s), ${db.packs.length} pack(s), ${db.views.length} view(s)`)
}

await reindex()

if (WATCH) {
  let timer: NodeJS.Timeout | undefined
  watch(cfg.root, { recursive: true }, (_event, filename) => {
    // The cache is written by us and can be inside the library; ignore it.
    if (filename && resolve(cfg.root, filename).startsWith(cfg.cacheDir)) return
    clearTimeout(timer)
    timer = setTimeout(() => void reindex(), DEBOUNCE_MS)
  })
  log(`watching ${cfg.root} (debounce ${DEBOUNCE_MS}ms)`)
}

log(`db at ${DB_PATH}, cache at ${cfg.cacheDir}${READ_ONLY ? ', read-only mode' : ''}`)

if (SERVE_STATIC) log(`serving the UI and library directly — open http://localhost:${PORT}/samples/ui/`)

startServer({
  cfg,
  port: PORT,
  serveStatic: SERVE_STATIC,
  uiDir: UI_DIR,
  db,
  index,
  folders,
  readOnly: READ_ONLY,
  reindex,
  remoteTtlMs: REMOTE_TTL_MS,
})
