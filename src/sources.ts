import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Config, Sounds } from './scan'
import { SAFE_NAME, soundName } from './scan'

export interface SourceDef {
  id: string
  label?: string
  /** github: index a public repo tree. manifest: read someone's published strudel.json. */
  type: 'github' | 'manifest'
  repo?: string
  /** Branch, tag, or commit SHA. Pin a SHA if you don't want audio changing under you. */
  ref?: string
  path?: string
  url?: string
  prefix?: string
}

export interface RemoteSource {
  def: SourceDef
  /** Absolute upstream base; a proxied path is this + the rest of the request. */
  base: string
  sounds: Sounds
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
const AUDIO = /\.(wav|mp3|ogg|flac|m4a|aiff?)$/i

export const remoteWarnings: string[] = []

/** Checks a source definition well enough to reject typos before a fetch. */
export function validateSourceDefs(input: unknown): { defs: SourceDef[]; errors: string[] } {
  const errors: string[] = []
  if (!Array.isArray(input)) return { defs: [], errors: ['expected an array of sources'] }

  const seen = new Set<string>()
  const defs: SourceDef[] = []

  for (const [i, item] of input.entries()) {
    const d = item as Partial<SourceDef>
    const where = d.id ? `source "${d.id}"` : `source ${i}`

    if (typeof d.id !== 'string' || !/^[A-Za-z0-9_]+$/.test(d.id)) {
      errors.push(`${where}: id must match [A-Za-z0-9_]+`)
      continue
    }
    if (seen.has(d.id)) {
      errors.push(`${where}: listed twice`)
      continue
    }
    if (d.type !== 'github' && d.type !== 'manifest') {
      errors.push(`${where}: type must be "github" or "manifest"`)
      continue
    }
    if (d.type === 'github' && (typeof d.repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(d.repo))) {
      errors.push(`${where}: repo must look like owner/name`)
      continue
    }
    if (d.type === 'manifest') {
      try {
        const u = new URL(String(d.url))
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme')
      } catch {
        errors.push(`${where}: url must be an http(s) URL`)
        continue
      }
    }
    if (d.prefix !== undefined && (typeof d.prefix !== 'string' || !/^[A-Za-z0-9_]*$/.test(d.prefix))) {
      errors.push(`${where}: prefix must be [A-Za-z0-9_]`)
      continue
    }

    seen.add(d.id)
    defs.push({
      id: d.id,
      label: typeof d.label === 'string' && d.label ? d.label : d.id,
      type: d.type,
      ...(d.repo ? { repo: d.repo } : {}),
      ...(d.ref ? { ref: d.ref } : {}),
      ...(d.path ? { path: d.path } : {}),
      ...(d.url ? { url: d.url } : {}),
      ...(d.prefix !== undefined ? { prefix: d.prefix } : {}),
    })
  }

  return { defs, errors }
}

export async function loadSourceDefs(file: string): Promise<SourceDef[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (!Array.isArray(parsed)) throw new Error('sources file must be an array')
    return (parsed as SourceDef[]).filter((s) => {
      if (!s.id || !/^[a-z0-9_]+$/i.test(s.id)) {
        remoteWarnings.push(`source id "${s.id}" must be [A-Za-z0-9_] — skipped`)
        return false
      }
      return true
    })
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code !== 'ENOENT') remoteWarnings.push(`sources file: ${e.message}`)
    return []
  }
}

export async function resolveSources(
  cfg: Config,
  defs: SourceDef[],
  ttlMs: number,
  force = false,
): Promise<RemoteSource[]> {
  remoteWarnings.length = 0
  const out: RemoteSource[] = []
  for (const def of defs) {
    try {
      out.push(await resolveOne(cfg, def, ttlMs, force))
    } catch (err) {
      remoteWarnings.push(`source "${def.id}": ${(err as Error).message}`)
    }
  }
  return out
}

async function resolveOne(cfg: Config, def: SourceDef, ttlMs: number, force: boolean): Promise<RemoteSource> {
  const cacheFile = join(cfg.cacheDir, `index-${def.id}.json`)

  if (!force) {
    try {
      const cached = JSON.parse(await readFile(cacheFile, 'utf8')) as {
        fetchedAt: number
        base: string
        sounds: Sounds
      }
      if (Date.now() - cached.fetchedAt < ttlMs) {
        return { def, base: cached.base, sounds: cached.sounds }
      }
    } catch {}
  }

  const built = def.type === 'github' ? await fromGithub(cfg, def) : await fromManifest(cfg, def)

  await mkdir(dirname(cacheFile), { recursive: true })
  await writeFile(cacheFile, JSON.stringify({ fetchedAt: Date.now(), ...built }, null, 2))
  return { def, ...built }
}

/** Lists a public repo's audio files via the git tree API and groups them by directory. */
async function fromGithub(cfg: Config, def: SourceDef): Promise<{ base: string; sounds: Sounds }> {
  if (!def.repo) throw new Error('github sources need "repo"')
  const ref = def.ref ?? 'main'
  const under = (def.path ?? '').replace(/^\/|\/$/g, '')

  const headers: Record<string, string> = { accept: 'application/vnd.github+json' }
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`

  const res = await fetch(`https://api.github.com/repos/${def.repo}/git/trees/${ref}?recursive=1`, { headers })
  if (!res.ok) {
    if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset') ?? 0) * 1000
      const mins = reset ? Math.max(1, Math.ceil((reset - Date.now()) / 60000)) : null
      throw new Error(
        `GitHub rate limit hit${mins ? ` (resets in ~${mins}m)` : ''} — set GITHUB_TOKEN for 5000/hr instead of 60/hr`,
      )
    }
    if (res.status === 404) throw new Error(`repo or ref not found: ${def.repo}@${ref}`)
    throw new Error(`tree API returned ${res.status}`)
  }
  const tree = (await res.json()) as { tree: { path: string; type: string }[]; truncated?: boolean }
  if (tree.truncated) {
    remoteWarnings.push(`source "${def.id}": repo tree was truncated by GitHub — narrow it with "path"`)
  }

  const grouped: Record<string, string[]> = {}
  for (const entry of tree.tree) {
    if (entry.type !== 'blob' || !AUDIO.test(entry.path)) continue
    if (under && !entry.path.startsWith(under + '/')) continue
    const rel = under ? entry.path.slice(under.length + 1) : entry.path
    const segments = rel.split('/')
    const file = segments.pop()
    if (!file || segments.length === 0) continue
    ;(grouped[segments.join('/')] ??= []).push(rel)
  }

  return {
    base: `https://raw.githubusercontent.com/${def.repo}/${ref}/${under ? under + '/' : ''}`,
    sounds: finish(cfg, def, grouped),
  }
}

/** Reads a strudel.json someone else already publishes. */
async function fromManifest(cfg: Config, def: SourceDef): Promise<{ base: string; sounds: Sounds }> {
  if (!def.url) throw new Error('manifest sources need "url"')

  const res = await fetch(def.url)
  if (!res.ok) throw new Error(`manifest returned ${res.status}`)
  const doc = (await res.json()) as Record<string, unknown>

  const base = new URL(typeof doc._base === 'string' && doc._base ? doc._base : './', def.url).href
  const grouped: Record<string, string[]> = {}
  for (const [name, value] of Object.entries(doc)) {
    if (name === '_base') continue
    const files = Array.isArray(value) ? value : [value]
    grouped[name] = files.filter((f): f is string => typeof f === 'string')
  }
  return { base, sounds: finish(cfg, def, grouped) }
}

/** Prefixes names, sorts variants naturally, and rewrites paths to the proxy route. */
function finish(cfg: Config, def: SourceDef, grouped: Record<string, string[]>): Sounds {
  const prefix = def.prefix ?? `${def.id}_`
  const sounds: Sounds = {}
  for (const folder of Object.keys(grouped).sort(collator.compare)) {
    const files = grouped[folder]
    if (!files.length) continue
    const base = soundName(folder.split('/'), cfg)
    if (!base) continue
    let name = `${prefix}${base}`
    if (!SAFE_NAME.test(name)) continue
    if (sounds[name]) {
      let n = 2
      while (sounds[`${name}_${n}`]) n++
      name = `${name}_${n}`
    }
    sounds[name] = [...files].sort(collator.compare).map((f) => `remote/${def.id}/${f}`)
  }
  return sounds
}
