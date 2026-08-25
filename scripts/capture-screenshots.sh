#!/usr/bin/env bash
# capture-screenshots.sh — regenerates docs/screenshots/ from a live dev server.
#
# Runs the whole UI against a throwaway sample library and UI store (never your
# real SAMPLES_DIR/DB_PATH), so it's safe to run any time without touching your
# own data. Requires: playwright-cli on PATH (or `npx playwright-cli`), ffmpeg
# (to synthesize placeholder audio), curl.
#
# Selectors below stick to the app's stable ids and data-* attributes
# (data-sound, data-star, data-path, data-chip, ...) rather than visible text —
# text/role matching is fragile here because sound names repeat across the
# local library and 200+ remote Dirt-Samples entries (e.g. "kick" also
# substring-matches "dirt_clubkick", "dirt_hardkick", ...).
#
# Usage:
#   npm run screenshots

set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${SCREENSHOT_PORT:-3098}"
BASE_URL="http://localhost:${PORT}"
FIXTURES="$(pwd)/.screenshot-fixtures"
SAMPLES_DIR="$FIXTURES/samples"
DB_DIR="$FIXTURES/data"
OUT="docs/screenshots"

PW() { playwright-cli "$@" 2>/dev/null || npx playwright-cli "$@"; }

cleanup() {
  PW close-all >/dev/null 2>&1 || true
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" >/dev/null 2>&1 || true
  rm -rf "$FIXTURES"
}
trap cleanup EXIT

# ─── Fixture library: a handful of tiny synthesized tones, not real audio ──
rm -rf "$FIXTURES"
mkdir -p "$SAMPLES_DIR/kick" "$SAMPLES_DIR/snare" "$SAMPLES_DIR/vox" "$SAMPLES_DIR/fx/breath" "$SAMPLES_DIR/moog" \
  "$SAMPLES_DIR/Splice/sounds/packs/Ambient Textures by Jane Doe/Ambient_Textures/AT_Riser/AT_Riser_One_Shots" \
  "$SAMPLES_DIR/Splice/sounds/packs/Ambient Textures by Jane Doe/Ambient_Textures/AT_Pad/AT_Pad_One_Shots" \
  "$DB_DIR"

gen() { ffmpeg -y -loglevel error -f lavfi -i "sine=frequency=$2:duration=$3" "$1"; }
gen "$SAMPLES_DIR/kick/kick_1.wav" 60 0.3
gen "$SAMPLES_DIR/kick/kick_2.wav" 55 0.3
gen "$SAMPLES_DIR/snare/snare_1.wav" 200 0.2
gen "$SAMPLES_DIR/vox/oh_1.wav" 300 0.5
gen "$SAMPLES_DIR/vox/oh_2.wav" 320 0.5
gen "$SAMPLES_DIR/vox/oh_10.wav" 340 0.5
gen "$SAMPLES_DIR/fx/breath/a.wav" 150 0.6
gen "$SAMPLES_DIR/fx/breath/b.wav" 160 0.6
gen "$SAMPLES_DIR/moog/moog_1.wav" 196 0.8
gen "$SAMPLES_DIR/moog/moog_2.wav" 220 0.8
gen "$SAMPLES_DIR/Splice/sounds/packs/Ambient Textures by Jane Doe/Ambient_Textures/AT_Riser/AT_Riser_One_Shots/AT_Riser_One_Shot_01.wav" 440 1.0
gen "$SAMPLES_DIR/Splice/sounds/packs/Ambient Textures by Jane Doe/Ambient_Textures/AT_Riser/AT_Riser_One_Shots/AT_Riser_One_Shot_02.wav" 460 1.0
gen "$SAMPLES_DIR/Splice/sounds/packs/Ambient Textures by Jane Doe/Ambient_Textures/AT_Pad/AT_Pad_One_Shots/AT_Pad_One_Shot_01.wav" 330 1.2

# ─── Start the dev server against the fixture library ─────────────────────
SAMPLES_DIR="$SAMPLES_DIR" DB_PATH="$DB_DIR/samplevault.json" SOURCES_FILE="$DB_DIR/sources.json" \
  CACHE_DIR="$SAMPLES_DIR/.cache" BASE_URL="$BASE_URL/samples/" PORT="$PORT" READ_ONLY=0 \
  npx tsx src/index.ts > "$FIXTURES.log" 2>&1 &
SERVER_PID=$!

echo "waiting for $BASE_URL ..."
for _ in $(seq 1 60); do
  curl -sf -o /dev/null "$BASE_URL/samples/api/health" && { echo "up"; break; }
  sleep 1
done

# ─── Seed a remote source, a pack, a view, and pitch notes via the API ─────
API="$BASE_URL/samples/api"
curl -s -X PUT "$API/sources" -H 'content-type: application/json' \
  -d '[{"id":"dirt","label":"Dirt-Samples","type":"github","repo":"tidalcycles/Dirt-Samples","ref":"main","prefix":"dirt_"}]' >/dev/null
curl -s -X POST "$API/sources/refresh" >/dev/null
curl -s -X PUT "$API/notes" -H 'content-type: application/json' \
  -d '{"moog/moog_1.wav":"g3","moog/moog_2.wav":"bb3","vox/oh_1.wav":"cs4"}' >/dev/null
curl -s -X PUT "$API/packs" -H 'content-type: application/json' \
  -d '[{"name":"livecut1","files":["vox/oh_1.wav","kick/kick_1.wav","fx/breath/a.wav"]}]' >/dev/null
curl -s -X PUT "$API/views" -H 'content-type: application/json' \
  -d '[{"name":"livecut1","sounds":["vox","kick","fx_breath"]}]' >/dev/null

mkdir -p "$OUT"

# ─── Drive the UI and capture every state ──────────────────────────────────
# One in-memory session for the whole pass — this is a single-page app with no
# concurrent-actor flows, so there's nothing to isolate between sessions here.
PW -s=ui open "$BASE_URL/samples/ui/"
PW -s=ui resize 1280 800

shot() { PW -s=ui screenshot --filename="$OUT/$1.png"; echo "captured $1"; }
run() { PW -s=ui run-code "async page => { $1 }"; }

shot guide

run "await page.locator('[data-sound=\"vox\"]').click();"
shot sound-unplayed

run "await page.locator('[data-path=\"vox/oh_1.wav\"]').click(); await page.waitForTimeout(600);"
shot waveform-playing

run "
  for (const name of ['fx_breath', 'kick', 'moog', 'vox']) {
    await page.locator(\`[data-star=\"\${name}\"]\`).click();
  }
"
shot starred

run "await page.locator('#onlystar').click();"
shot starred-filtered

run "
  await page.locator('[data-path=\"vox/oh_1.wav\"] .add').click();
  await page.locator('[data-sound=\"kick\"]').click();
  await page.locator('[data-path=\"kick/kick_1.wav\"] .add').click();
  await page.locator('[data-sound=\"fx_breath\"]').click();
  await page.locator('[data-path=\"fx/breath/a.wav\"] .add').click();
"
shot pack-builder

run "await page.locator('#copypack').click();"
shot copy-snippet

run "
  await page.locator('#packname').fill('livecut2');
  await page.locator('#publish').click();
"
shot publish

run "
  await page.locator('#viewname').fill('livemix');
  await page.locator('#saveview').click();
"
shot view-saved

run "await page.locator('#copyurl').click();"
shot copy-manifest-url

run "
  await page.locator('#viewpick').selectOption(['']);
  await page.locator('#managesources').click();
"
shot remote-repos

run "await page.locator('#f_type').selectOption(['manifest']);"
shot remote-add-manifest-kind

run "
  await page.locator('#f_id').fill('selfcheck');
  await page.locator('#f_label').fill('Self (demo)');
  await page.locator('#f_url').fill('$BASE_URL/samples/strudel.json');
  await page.locator('#dopreview').click();
  await page.waitForTimeout(800);
  await page.getByRole('heading', { name: /^Preview:/ }).scrollIntoViewIfNeeded();
"
shot remote-preview-results

run "
  await page.locator('#closesources').click();
  await page.locator('#refresh').click();
  await page.waitForTimeout(500);
"
shot rescan

run "await page.locator('[data-sound=\"fx_breath\"]').click(); await page.locator('#rename').click();"
PW -s=ui dialog-accept "breath"
shot renamed

run "
  await page.locator('[data-sound=\"kick\"]').click();
  await page.locator('[data-path=\"kick/kick_1.wav\"] .note-in').fill('zz9');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(300);
"
shot note-rejected

run "await page.locator('[data-group=\"local\"]').click();"
shot group-collapsed
run "await page.locator('[data-group=\"local\"]').click();"

PW -s=ui resize 390 844
run "await page.waitForTimeout(300);"
shot mobile-sound
PW -s=ui resize 1280 800

run "await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForTimeout(300);"
shot dark-mode

echo "all done — $(ls "$OUT"/*.png | wc -l | tr -d ' ') screenshots in $OUT/"
