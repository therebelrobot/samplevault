import type { Pack, View } from './db'
import type { Config, Sounds } from './scan'

/**
 * Renders a strudel.json document from the in-memory index. Nothing is stored;
 * every request reflects the current library, sources, and UI store.
 */
export function renderManifest(cfg: Config, sounds: Sounds, packs: Pack[], view?: View): Record<string, unknown> {
  const doc: Record<string, unknown> = { _base: cfg.baseUrl }

  if (!view) {
    for (const [name, files] of Object.entries(sounds)) doc[name] = files
    for (const p of packs) doc[p.name] = p.files
    return doc
  }

  const byPack = new Map(packs.map((p) => [p.name, p.files]))
  for (const name of view.sounds) {
    const files = sounds[name] ?? byPack.get(name)
    // A view can outlive the sound it names — a renamed folder, a removed
    // source. Skip quietly rather than emitting a broken entry.
    if (files) doc[name] = files
  }
  return doc
}
