import type { Pack } from './db'
import { SAFE_NAME, type Sounds } from './scan'

export interface Validation {
  ok: boolean
  errors: string[]
  packs: Pack[]
}

/**
 * A pack is only accepted if its name is usable in mini-notation, every file
 * it lists actually exists, and it does not collide with another pack in the
 * same namespace. A pack scoped to a view (`view` set) is that view's private
 * namespace: it may shadow a global sound name, and its uniqueness is scoped
 * to that view rather than global.
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
    let view: string | null = null
    if (p.view != null && p.view !== '') {
      if (typeof p.view !== 'string' || !SAFE_NAME.test(p.view)) {
        errors.push(`${where}: view must match [A-Za-z0-9_]+`)
        continue
      }
      view = p.view
    }
    if (!view && sounds[p.name]) {
      errors.push(`${where}: "${p.name}" already exists as a sound — pick another name`)
      continue
    }
    const key = `${view ?? ''} ${p.name}`
    if (seen.has(key)) {
      errors.push(`${where}: "${p.name}"${view ? ` in view "${view}"` : ''} is listed twice`)
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

    seen.add(key)
    packs.push({
      name: p.name,
      files: [...p.files],
      view,
      published: typeof p.published === 'string' ? p.published : new Date().toISOString(),
    })
  }

  return { ok: errors.length === 0, errors, packs }
}
