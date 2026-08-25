import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SourceDef } from './sources'

export interface Pack {
  name: string
  files: string[]
  /** View this pack is namespaced to, or null for a pack visible everywhere. */
  view: string | null
  published: string
}

/** A named subset of the library, served as its own manifest. */
export interface View {
  name: string
  sounds: string[]
  saved: string
}

export interface DbShape {
  packs: Pack[]
  views: View[]
  /** folder path -> sound name */
  names: Record<string, string>
  /** Remote sample repos, managed from the UI. */
  sources: SourceDef[]
  /** file path (relative to the samples root) -> note, e.g. "moog/005.wav" -> "g3" */
  notes: Record<string, string>
}

const EMPTY: DbShape = { packs: [], views: [], names: {}, sources: [], notes: {} }

/**
 * The UI's store. Small, JSON, and deliberately separate from the sample
 * library so it can live next to docker-compose.yml while the library and its
 * cache stay on whatever volume has the space.
 */
export class Db {
  private data: DbShape = structuredClone(EMPTY)

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Partial<DbShape>
      this.data = {
        packs: Array.isArray(parsed.packs) ? parsed.packs : [],
        views: Array.isArray(parsed.views) ? parsed.views : [],
        names: parsed.names && typeof parsed.names === 'object' ? parsed.names : {},
        sources: Array.isArray(parsed.sources) ? parsed.sources : [],
        notes: parsed.notes && typeof parsed.notes === 'object' ? parsed.notes : {},
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code !== 'ENOENT') throw new Error(`db at ${this.path}: ${e.message}`)
      this.data = structuredClone(EMPTY)
    }
  }

  get packs(): Pack[] {
    return this.data.packs
  }
  get views(): View[] {
    return this.data.views
  }
  get names(): Record<string, string> {
    return this.data.names
  }
  get sources(): SourceDef[] {
    return this.data.sources
  }
  get notes(): Record<string, string> {
    return this.data.notes
  }

  async update(fn: (d: DbShape) => void): Promise<void> {
    fn(this.data)
    await this.save()
  }

  /** Write to a temp file and rename, so a crash mid-write can't corrupt the store. */
  private async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.part`
    await writeFile(tmp, JSON.stringify(this.data, null, 2) + '\n')
    await rename(tmp, this.path)
  }
}
