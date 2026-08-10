import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Db, View } from './db'
import type { Index } from './index'
import { renderManifest } from './manifest'
import { validate } from './packs'
import { serveRemote } from './proxy'
import { knownFiles, SAFE_NAME, type Config } from './scan'
import { serveFile } from './static'
import { resolveSources, validateSourceDefs, type SourceDef } from './sources'

const MAX_BODY = 512 * 1024

export interface ServerDeps {
  cfg: Config
  port: number
  /** Serve the UI and audio directly, so `npm run dev` needs no nginx. */
  serveStatic: boolean
  uiDir: string
  db: Db
  index: Index
  /** sound name -> folder, for renaming */
  folders: Record<string, string>
  readOnly: boolean
  reindex: (force?: boolean) => Promise<void>
  remoteTtlMs: number
}

export function startServer(deps: ServerDeps) {
  const server = createServer((req, res) => {
    handle(req, res, deps).catch((err: Error) => json(res, 500, { error: err.message }))
  })
  server.listen(deps.port, () => console.log(`api listening on :${deps.port}`))
  return server
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const { cfg, db, index, readOnly, reindex } = deps
  const url = new URL(req.url ?? '/', 'http://localhost')

  if (url.pathname === '/') {
    res.writeHead(302, { location: '/samples/ui/' })
    res.end()
    return
  }

  // Mirror the nginx URL shape so the UI's relative fetches work identically
  // whether it is served by nginx or by this process during development.
  let path = url.pathname
  if (path.startsWith('/samples/')) {
    const rest = path.slice('/samples'.length)
    if (rest.startsWith('/api/')) path = rest
    else if (rest === '/strudel.json') path = '/api/manifest'
    else if (rest.startsWith('/m/')) path = '/api/manifest/' + rest.slice('/m/'.length)
    else if (rest.startsWith('/remote/')) path = '/api' + rest
    else if (deps.serveStatic) {
      const isUi = rest.startsWith('/ui/') || rest === '/ui'
      const served = isUi
        ? await serveFile(res, deps.uiDir, rest.replace(/^\/ui\/?/, ''))
        : await serveFile(res, cfg.root, rest)
      if (served) return
      return json(res, 404, { error: `not found: ${url.pathname}` })
    }
  }

  const route = `${req.method} ${path.replace(/\/$/, '')}`

  // --- manifests: rendered per request, never stored ---

  if (route === 'GET /api/manifest') {
    return json(res, 200, renderManifest(cfg, index.sounds, db.packs))
  }

  if (req.method === 'GET' && path.startsWith('/api/manifest/')) {
    const name = decodeURIComponent(path.slice('/api/manifest/'.length)).replace(/\.json$/, '')
    const view = db.views.find((v) => v.name === name)
    if (!view) return json(res, 404, { error: `no view named "${name}"` })
    return json(res, 200, renderManifest(cfg, index.sounds, db.packs, view))
  }

  if (req.method === 'GET' && path.startsWith('/api/remote/')) {
    // Previews are included so a candidate source can be auditioned before it
    // is added to the library.
    return serveRemote(res, cfg, [...index.remotes, ...index.previews], path.slice('/api/remote/'.length))
  }

  // --- reads ---

  if (route === 'GET /api/health') {
    return json(res, 200, { ok: true, base: cfg.baseUrl, readOnly, builtAt: index.builtAt })
  }

  if (route === 'GET /api/sources') {
    const resolved = new Map(index.remotes.map((r) => [r.def.id, r]))
    return json(
      res,
      200,
      db.sources.map((def) => {
        const r = resolved.get(def.id)
        return {
          ...def,
          label: def.label ?? def.id,
          origin: r?.base ?? null,
          sounds: r ? Object.keys(r.sounds) : [],
          resolved: Boolean(r),
        }
      }),
    )
  }

  if (route === 'GET /api/packs') return json(res, 200, db.packs)
  if (route === 'GET /api/views') return json(res, 200, db.views)
  if (route === 'GET /api/names') return json(res, 200, db.names)
  if (route === 'GET /api/folders') return json(res, 200, deps.folders)

  // --- writes ---

  if (readOnly && req.method !== 'GET') {
    return json(res, 403, { error: 'read-only mode — set READ_ONLY=0 to allow changes' })
  }

  if (route === 'POST /api/sources/preview') {
    const body = await readBody(req)
    const { defs, errors } = validateSourceDefs(Array.isArray(body) ? body : [body])
    if (errors.length) return json(res, 422, { errors })
    const [def] = defs
    if (!def) return json(res, 422, { errors: ['no source given'] })

    const [resolved] = await resolveSources(cfg, [def], deps.remoteTtlMs, true)
    if (!resolved) return json(res, 502, { errors: ['could not resolve that source — check the log'] })

    // Keep it addressable by the proxy so its audio plays, without it entering
    // the manifest.
    index.previews = index.previews.filter((p) => p.def.id !== def.id).concat(resolved)

    const collisions = Object.keys(resolved.sounds).filter((n) => index.sounds[n])
    return json(res, 200, {
      id: def.id,
      origin: resolved.base,
      sounds: Object.entries(resolved.sounds).map(([name, files]) => ({ name, files })),
      collisions,
    })
  }

  if (route === 'PUT /api/sources') {
    const body = await readBody(req)
    const { defs, errors } = validateSourceDefs(body)
    if (errors.length) return json(res, 422, { errors })
    await db.update((d) => {
      d.sources = defs
    })
    index.previews = []
    await reindex()
    return json(res, 200, db.sources)
  }

  if (req.method === 'DELETE' && path.startsWith('/api/sources/')) {
    const id = decodeURIComponent(path.slice('/api/sources/'.length))
    if (!db.sources.some((s) => s.id === id)) return json(res, 404, { error: `no source "${id}"` })
    await db.update((d) => {
      d.sources = d.sources.filter((s) => s.id !== id)
    })
    await reindex()
    return json(res, 200, db.sources)
  }

  if (route === 'POST /api/sources/refresh') {
    await reindex(true)
    return json(res, 200, { refreshed: index.remotes.map((s) => s.def.id) })
  }

  if (route === 'PUT /api/packs') {
    const body = await readBody(req)
    const result = validate(body, index.sounds, knownFiles(index.sounds))
    if (!result.ok) return json(res, 422, { errors: result.errors })
    await db.update((d) => {
      d.packs = result.packs
    })
    return json(res, 200, db.packs)
  }

  if (req.method === 'DELETE' && path.startsWith('/api/packs/')) {
    const name = decodeURIComponent(path.slice('/api/packs/'.length))
    if (!db.packs.some((p) => p.name === name)) return json(res, 404, { error: `no pack named "${name}"` })
    await db.update((d) => {
      d.packs = d.packs.filter((p) => p.name !== name)
    })
    return json(res, 200, db.packs)
  }

  if (route === 'PUT /api/views') {
    const body = await readBody(req)
    const { views, errors } = validateViews(body, deps)
    if (errors.length) return json(res, 422, { errors })
    await db.update((d) => {
      d.views = views
    })
    return json(res, 200, db.views)
  }

  if (req.method === 'DELETE' && path.startsWith('/api/views/')) {
    const name = decodeURIComponent(path.slice('/api/views/'.length))
    if (!db.views.some((v) => v.name === name)) return json(res, 404, { error: `no view named "${name}"` })
    await db.update((d) => {
      d.views = d.views.filter((v) => v.name !== name)
    })
    return json(res, 200, db.views)
  }

  if (route === 'PUT /api/names') {
    const body = await readBody(req)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return json(res, 422, { errors: ['expected an object of "folder/path": "name"'] })
    }
    const errors: string[] = []
    const names: Record<string, string> = {}
    for (const [folder, name] of Object.entries(body as Record<string, unknown>)) {
      if (typeof name !== 'string' || !SAFE_NAME.test(name)) {
        errors.push(`"${String(name)}" is not [A-Za-z0-9_]`)
        continue
      }
      names[folder.replace(/^\/|\/$/g, '')] = name
    }
    if (errors.length) return json(res, 422, { errors })
    await db.update((d) => {
      d.names = names
    })
    await reindex()
    return json(res, 200, db.names)
  }

  json(res, 404, { error: 'no such route' })
}

function validateViews(input: unknown, deps: ServerDeps): { views: View[]; errors: string[] } {
  const errors: string[] = []
  if (!Array.isArray(input)) return { views: [], errors: ['expected an array of views'] }

  const known = new Set([...Object.keys(deps.index.sounds), ...deps.db.packs.map((p) => p.name)])
  const seen = new Set<string>()
  const views: View[] = []

  for (const [i, item] of input.entries()) {
    const v = item as Partial<View>
    if (typeof v.name !== 'string' || !SAFE_NAME.test(v.name)) {
      errors.push(`view ${i}: name must match [A-Za-z0-9_]+`)
      continue
    }
    if (seen.has(v.name)) {
      errors.push(`view ${i}: "${v.name}" is listed twice`)
      continue
    }
    if (!Array.isArray(v.sounds) || v.sounds.length === 0) {
      errors.push(`view ${i}: needs at least one sound`)
      continue
    }
    const missing = v.sounds.filter((s) => typeof s !== 'string' || !known.has(s))
    if (missing.length) {
      errors.push(`view ${i}: ${missing.length} sound(s) not in the library`)
      continue
    }
    seen.add(v.name)
    views.push({ name: v.name, sounds: [...v.sounds], saved: new Date().toISOString() })
  }

  return { views, errors }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new Error('request body too large')
    chunks.push(chunk as Buffer)
  }
  if (!chunks.length) return null
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
