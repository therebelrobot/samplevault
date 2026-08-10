import { createReadStream } from 'node:fs'
import { mkdir, rename, stat, writeFile } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { dirname, join, normalize } from 'node:path'
import type { Config } from './scan'
import type { RemoteSource } from './sources'

const TYPES: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
}

/**
 * Serves remote/<sourceId>/<path>. First request pulls from upstream and writes
 * a disk copy; every later request is local, so auditioning a remote pack does
 * not re-hit GitHub and keeps working if upstream disappears.
 */
export async function serveRemote(
  res: ServerResponse,
  cfg: Config,
  sources: RemoteSource[],
  rest: string,
): Promise<void> {
  const slash = rest.indexOf('/')
  if (slash < 1) return fail(res, 400, 'expected remote/<source>/<path>')

  const id = rest.slice(0, slash)
  const path = decodeURIComponent(rest.slice(slash + 1))

  const source = sources.find((s) => s.def.id === id)
  if (!source) return fail(res, 404, `no source "${id}"`)

  // Path traversal guard: the resolved upstream must stay under the source base.
  if (path.includes('..') || normalize(path) !== path || path.startsWith('/')) {
    return fail(res, 400, 'bad path')
  }
  const upstream = new URL(path, source.base)
  if (!upstream.href.startsWith(source.base)) return fail(res, 400, 'path escapes the source')

  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const type = TYPES[ext] ?? 'application/octet-stream'
  const cached = join(cfg.cacheDir, id, path)

  try {
    const info = await stat(cached)
    res.writeHead(200, {
      'content-type': type,
      'content-length': info.size,
      'cache-control': 'public, max-age=86400',
      'x-samplevault-cache': 'hit',
    })
    createReadStream(cached).pipe(res)
    return
  } catch {}

  const upRes = await fetch(upstream)
  if (!upRes.ok || !upRes.body) return fail(res, upRes.status === 404 ? 404 : 502, `upstream ${upRes.status}`)

  const bytes = Buffer.from(await upRes.arrayBuffer())
  await mkdir(dirname(cached), { recursive: true })
  // Write to a temp name first so a killed request can't leave a truncated file
  // that later reads would treat as a valid cache hit.
  const tmp = `${cached}.${process.pid}.part`
  await writeFile(tmp, bytes)
  await rename(tmp, cached)

  res.writeHead(200, {
    'content-type': type,
    'content-length': bytes.length,
    'cache-control': 'public, max-age=86400',
    'x-samplevault-cache': 'miss',
  })
  res.end(bytes)
}

function fail(res: ServerResponse, status: number, message: string): void {
  const body = JSON.stringify({ error: message })
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}
