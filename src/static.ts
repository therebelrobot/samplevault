import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { extname, join, resolve } from 'node:path'

export const MIME: Record<string, string> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

/**
 * Minimal static file serving so `npm run dev` can stand in for nginx and serve
 * the whole app from one process. In production nginx matches these paths first
 * and this code never runs.
 *
 * Returns false when there is nothing to serve, so the caller can 404.
 */
export async function serveFile(res: ServerResponse, rootDir: string, relPath: string): Promise<boolean> {
  const clean = decodeURIComponent(relPath).replace(/^\/+/, '')
  const full = resolve(rootDir, clean)

  // Anything that resolves outside the root is a traversal attempt.
  if (full !== rootDir && !full.startsWith(rootDir + '/')) return false

  let target = full
  try {
    const info = await stat(full)
    if (info.isDirectory()) target = join(full, 'index.html')
  } catch {
    return false
  }

  let size: number
  try {
    const info = await stat(target)
    if (!info.isFile()) return false
    size = info.size
  } catch {
    return false
  }

  const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream'
  res.writeHead(200, {
    'content-type': type,
    'content-length': size,
    'cache-control': 'no-cache',
  })
  createReadStream(target).pipe(res)
  return true
}
