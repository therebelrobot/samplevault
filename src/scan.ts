import { readdir } from 'node:fs/promises'
import { extname, join } from 'node:path'

export interface Config {
  root: string
  cacheDir: string
  baseUrl: string
  nameSep: string
  exts: string[]
  /** How many trailing path segments contribute to a sound name. 0 = all. */
  nameDepth: number
}

/** sound name -> file paths, relative to the samples root, in index order */
export type Sounds = Record<string, string[]>

export const SAFE_NAME = /^[A-Za-z0-9_]+$/

/** A Strudel note name: letter, optional sharp/flat marks, optional octave — e.g. g3, bb3, cs4, e. */
export const SAFE_NOTE = /^[a-gA-G](s|f)*-?\d*$/

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

export const warnings: string[] = []
/** Sound name -> folder it came from, so the UI can rename by folder. */
export const folders: Record<string, string> = {}

/**
 * Turns path segments into a name mini-notation can parse.
 *
 * Commercial libraries nest deeply and repeat themselves —
 * "packs/World Class Percussion by X/WCP_Riq/WCP_Riq_One_Shots" — so the last
 * nameDepth segments are tokenised, deduplicated, and rejoined:
 *   WCP_Riq_One_Shots
 */
export function soundName(segments: string[], cfg: Config): string {
  const kept = cfg.nameDepth > 0 ? segments.slice(-cfg.nameDepth) : segments
  const seen = new Set<string>()
  const tokens: string[] = []

  for (const segment of kept) {
    for (const token of segment.split(/[^A-Za-z0-9]+/)) {
      if (!token) continue
      const key = token.toLowerCase()
      if (seen.has(key)) continue // drop the repeat, keep the first occurrence
      seen.add(key)
      tokens.push(token)
    }
  }

  return tokens.join(cfg.nameSep)
}

/**
 * Walks the samples root. A directory containing audio becomes one sound; its
 * files are the indexed variants. Nothing is written — the caller holds the
 * result in memory and renders manifests from it on request.
 */
export async function scan(cfg: Config, overrides: Record<string, string> = {}): Promise<Sounds> {
  warnings.length = 0
  for (const k of Object.keys(folders)) delete folders[k]

  const out: Sounds = {}
  await walk(cfg, cfg.root, [], out, overrides)

  const sorted: Sounds = {}
  for (const name of Object.keys(out).sort(collator.compare)) sorted[name] = out[name]
  return sorted
}

async function walk(
  cfg: Config,
  dir: string,
  segments: string[],
  out: Sounds,
  overrides: Record<string, string>,
): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    warnings.push(`could not read ${dir}: ${(err as NodeJS.ErrnoException).code}`)
    return
  }

  const files = entries
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .filter((e) => cfg.exts.includes(extname(e.name).toLowerCase()))
    .map((e) => e.name)
    // Natural sort, so oh_2 lands at :1 and oh_10 at :2 rather than the reverse.
    .sort(collator.compare)

  if (files.length) {
    if (segments.length === 0) {
      warnings.push(`${files.length} loose file(s) at the root ignored — a sound needs its own folder`)
    } else {
      const folder = segments.join('/')
      const generated = overrides[folder] ?? soundName(segments, cfg)

      if (!generated) {
        warnings.push(`"${folder}" has no usable characters for a sound name — rename it in the UI`)
      } else {
        const name = unique(generated, out)
        folders[name] = folder
        out[name] = files.map((f) => [...segments, f].join('/'))
      }
    }
  }

  for (const d of entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'))) {
    if (join(dir, d.name) === cfg.cacheDir) continue
    await walk(cfg, join(dir, d.name), [...segments, d.name], out, overrides)
  }
}

/** Shortening names can collide; suffix rather than silently dropping a folder. */
function unique(name: string, out: Sounds): string {
  if (!out[name]) return name
  let n = 2
  while (out[`${name}_${n}`]) n++
  return `${name}_${n}`
}

/** Every file path the index knows about, for validating pack contents. */
export function knownFiles(sounds: Sounds): Set<string> {
  const set = new Set<string>()
  for (const files of Object.values(sounds)) for (const f of files) set.add(f)
  return set
}
