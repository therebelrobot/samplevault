import type { Pack } from './db'
import { SAFE_NAME, type Sounds } from './scan'

export interface Validation {
  ok: boolean
  errors: string[]
  packs: Pack[]
}

/**
 * A pack is only accepted if its name is usable in mini-notation, does not
 * shadow an indexed sound, and every file it lists actually exists.
 */
export function validate(input: unknown, sounds: Sounds, files: Set<string>): Validation {
  const errors: string[] = []
  if (!Array.isArray(input)) return { ok: false, errors: ['expected an array of packs'], packs: [] }

  const seen = new Set<string>()
  const packs: Pack[] = []

  for (const [i, item] of input.entries()) {
    const p = item as Partial<Pack>
    const where = `pack ${i}`

    if (typeof p.name !== 'string' || !SAFE_NAME.test(p.name)) {
      errors.push(`${where}: name must match [A-Za-z0-9_]+`)
      continue
    }
    if (sounds[p.name]) {
      errors.push(`${where}: "${p.name}" already exists as a sound — pick another name`)
      continue
    }
    if (seen.has(p.name)) {
      errors.push(`${where}: "${p.name}" is listed twice`)
      continue
    }
    if (!Array.isArray(p.files) || p.files.length === 0) {
      errors.push(`${where}: needs at least one file`)
      continue
    }
    const missing = p.files.filter((f) => typeof f !== 'string' || !files.has(f))
    if (missing.length) {
      errors.push(`${where}: ${missing.length} file(s) not in the library`)
      continue
    }

    seen.add(p.name)
    packs.push({
      name: p.name,
      files: [...p.files],
      published: typeof p.published === 'string' ? p.published : new Date().toISOString(),
    })
  }

  return { ok: errors.length === 0, errors, packs }
}
