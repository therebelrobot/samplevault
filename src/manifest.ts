import type { Pack, View } from './db'
import type { Config, Sounds } from './scan'

/**
 * A sound plays by index (`:0 :1`) unless every one of its files has a note
 * assigned, in which case it renders as Strudel's pitch-map form so
 * `note(...).s(...)` picks the closest matching sample. Strudel does not
 * support mixing the two within one entry, so a partially-noted sound falls
 * back to the plain array until the rest are filled in.
 */
function renderEntry(files: string[], notes: Record<string, string>): string[] | Record<string, string> {
  if (files.length && files.every((f) => notes[f])) {
    const byNote: Record<string, string> = {}
    for (const f of files) byNote[notes[f]] = f
    return byNote
  }
  return files
}

/**
 * Renders a strudel.json document from the in-memory index. Nothing is stored;
 * every request reflects the current library, sources, and UI store.
 */
export function renderManifest(
  cfg: Config,
  sounds: Sounds,
  packs: Pack[],
  notes: Record<string, string>,
  view?: View,
): Record<string, unknown> {
  const doc: Record<string, unknown> = { _base: cfg.baseUrl }
  const globalPacks = packs.filter((p) => !p.view)

  if (!view) {
    for (const [name, files] of Object.entries(sounds)) doc[name] = renderEntry(files, notes)
    for (const p of globalPacks) doc[p.name] = renderEntry(p.files, notes)
    return doc
  }

  const byPack = new Map(globalPacks.map((p) => [p.name, p.files]))
  for (const name of view.sounds) {
    const files = sounds[name] ?? byPack.get(name)
    // A view can outlive the sound it names — a renamed folder, a removed
    // source. Skip quietly rather than emitting a broken entry.
    if (files) doc[name] = renderEntry(files, notes)
  }
  // Packs scoped to this view are intrinsic to it — no need to list them in
  // `sounds` — and take priority over anything already resolved above.
  for (const p of packs) if (p.view === view.name) doc[p.name] = renderEntry(p.files, notes)
  return doc
}
