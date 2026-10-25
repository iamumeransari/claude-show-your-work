// The player: playback (frames, swaps, play and seek) and the components that
// draw it in the chat.
import type { EngineInterface, Timer } from 'claude-code'

import type { Check, KeyChange, Shown, Summary } from '../types'

import { state } from './state'
import { clock, drawBox, layoutOf, oneLine, pagesOf, pixelsFor, PX_MAX, remeasure, SIDE, SIDEBAR, sizeFor, sizeStep, tabLabel, targetBox, wrapWords } from './layout'
import { act, debug, track } from './telemetry'
import { compareFrame, frameFile, frameReady, identityOf, isFrameCut, isGone, keyOf, MAX_STILL, PAIR_GAP, pairReady, pngSize, prepareVideo, recutFrame, toOriginal, toUpdated } from './media'
import { prepared, preparedOf } from './history'
import { tourHeard } from './tour'

// Playback per drawn site (a transcript row's tool_use_id, or the pane).
type Player = {
  frame: number
  timer?: Timer
  isCompare?: boolean
  isSplit?: boolean
  // which earlier version the compared side is, when there are several
  step?: number
  // the sidebar lists the versions instead of what changed
  isHistory?: boolean
  // scrolled out of view since it was last drawn
  wasAway?: boolean
  // back in view: send the frame on screen again after drawing
  resend?: boolean
  // state.drawnBytes when this player's picture was last sent
  drawnAt?: number
  hasAutoplayed?: boolean
  // how many bar cells the scrub row last drew, so playback redraws only on a change
  segments?: number
  // which page of key changes the sidebar shows
  changesPage?: number
  // where the updated video was, kept while a still original is shown
  updatedFrame?: number
  // the picture's size in cells as last drawn, for repaints
  box?: { columns: number; rows: number }
}
export const players = new Map<string, Player>()
// Calls made since this load: only these autoplay, not every window a reload redraws.
export const freshCalls = new Set<string>()
// Each window's own repaint count, beside state.version for all of them.
export const versions = new Map<string, number>()

// A change to one window bumps only its own count, so the others hand back
// their kept drawing when the repaint reaches them.
export function redraw($: EngineInterface, site?: string) {
  if (site) versions.set(site, (versions.get(site) ?? 0) + 1)
  else state.version += 1
  $.ui.invalidate('ui.render')
}
export const player = (site: string): Player => {
  let one = players.get(site)
  if (!one) players.set(site, (one = { frame: 0 }))

  return one
}

// Opens a file, folder or URL with the desktop's default app.
//
// On Linux, xdg-open on a desktop it doesn't recognise (niri, sway…) runs the
// app in the foreground until it quits, and $.process.run kills whatever is
// still running at its timeout (30 s by default). So the script below starts
// xdg-open in a session of its own, then watches it for up to a second:
//   - xdg-open exits within the second (GNOME and KDE hand the file off and
//     return; a missing app fails fast): its exit code and error text come back.
//   - still running after the second: the app is open in the foreground, so
//     the script returns 0 and leaves it running, outside what the timeout kills.
// The exit code goes through a file, because a background job that has exited
// still answers `kill -0` until it is reaped. The helper's own input and output
// go to /dev/null too: $.process.run waits until every holder of its pipes exits.
export const OPEN_SH = [
  'command -v "$1" >/dev/null || exit 127',
  'st="${TMPDIR:-/tmp}/syw-open-$$"',
  'run=; command -v setsid >/dev/null && run=setsid',
  '$run sh -c \'"$@" </dev/null >/dev/null 2>"$0.err"; echo $? > "$0"; sleep 2; rm -f "$0" "$0.err"\' "$st" "$@" </dev/null >/dev/null 2>&1 &',
  'i=0',
  'while [ $i -lt 10 ]; do',
  '  if [ -s "$st" ]; then code=$(cat "$st"); cat "$st.err" >&2; rm -f "$st" "$st.err"; exit "$code"; fi',
  '  sleep 0.1 2>/dev/null || sleep 1; i=$((i + 1))',
  'done',
  'exit 0',
].join('\n')
const openArgv = (target: string) => (state.isMac ? ['open', target] : ['sh', '-c', OPEN_SH, 'sh', 'xdg-open', target])

// What went wrong opening something, in words: from xdg-open's exit codes
// (2 no such file, 3 no app or tool for it, 4 the app failed) and from macOS
// open's error text. `what` names the kind of thing, as in "no app opens videos".
export function openFailure(r: { exitCode: number; stderr: string }, what: string, path: string) {
  const said = r.stderr.trim().split('\n')[0]?.trim().slice(0, 100) ?? ''
  if (r.exitCode === 127) return "Couldn't open it: xdg-open is missing. Install xdg-utils and try again."
  if (r.exitCode === 2 || /does not exist|no such file/i.test(said)) return `Couldn't open it: nothing is at ${path} any more.`
  if (r.exitCode === 3 || /no application knows|no application|no method available|no default/i.test(said)) return `Couldn't open it: no app on this computer is set to open ${what}.`
  if (r.exitCode === 4) return said ? `Couldn't open it: ${said}` : `Couldn't open it: the app for ${what} failed to start.`
  return said ? `Couldn't open it: ${said}` : `Couldn't open it (error ${r.exitCode}).`
}

// The narrowest the scrub and button rows get, in columns: room for the play
// button, both times, a usable bar and the action buttons on one line.
const CONTROLS_MIN = 64

// A player whose box needs more pixels than its picture has (a bigger
// window, a pane, no report beside it) gets a sharper copy, made once in the
// background from the original file and swapped into the same object, so a
// playing video carries on. Stills stop at twice their own width (an icon
// stays small) and MAX_STILL; videos at PX_MAX.
const sharpKey = (m: Shown) => `${m.kind}|${m.source ?? m.path}`
const sharpening = new Map<string, number>()
const sharpest = new Map<string, Pick<Shown, 'path' | 'width' | 'height' | 'generation' | 'frames'>>()
function useSharpest(m: Shown) {
  const better = sharpest.get(sharpKey(m))
  if (better && better.width > m.width) Object.assign(m, better)
}
function sharpen($: EngineInterface, m: Shown, need: number) {
  const source = m.source
  // Stills are enlarged up to twice their width (three times in Large). Video
  // frames stop at PX_MAX in both: bigger frames cost cutting time and memory
  // on every frame, and a Large player stretches them a little instead.
  const limit = m.frames ? PX_MAX : Math.min(MAX_STILL, (m.sourceWidth ?? m.width) * 2 * sizeStep())
  const want = Math.min(limit, need)
  const key = sharpKey(m)
  if (!source || want < m.width * 1.15 || (sharpening.get(key) ?? 0) >= want) return
  sharpening.set(key, want)
  void (async () => {
    const made = m.frames
      ? await prepareVideo($, source, m.title, await identityOf($, source), want)
      : await widenStill($, source, want)
    if (!made) return
    sharpest.set(key, { path: made.path, width: made.width, height: made.height, generation: made.generation, frames: made.frames })
    useSharpest(m)
    redraw($)
  })().catch(() => undefined)
}
async function widenStill($: EngineInterface, source: string, width: number): Promise<Shown | null> {
  const out = `${state.TMP}/w-${keyOf(source)}-${width}.png`
  const made = state.isMac
    ? await $.process.run(['sips', '-s', 'format', 'png', '--resampleWidth', String(width), source, '--out', out]).catch(() => null)
    : await $.process.run([state.ffmpeg, '-v', 'error', '-y', '-i', source, '-frames:v', '1', '-vf', `scale=${width}:-2:flags=lanczos`, out]).catch(() => null)
  if (!made || made.exitCode !== 0) return null
  state.generation += 1
  return { kind: 'image', path: out, source, ...(await pngSize($, out)), title: '', generation: state.generation }
}
// The window size the cell was last measured at (see Viewer).
let cellFor = ''

// What a check did between the compared side and this one.
export function checkDiff(now: Check[] = [], before: Check[] = []) {
  const was = new Map(before.map(c => [c.name, c.ok]))
  const fixed = now.filter(c => c.ok && was.get(c.name) === false)
  const broken = now.filter(c => !c.ok && was.get(c.name) === true)

  return { fixed, broken }
}

// The play control's word for where the clip is.
export function playWord(isPlaying: boolean, frame: number, count: number) {
  if (isPlaying) return '❚❚ Pause'
  if (count > 1 && frame >= count - 1) return '↺ Replay'

  return frame > 0 ? '▶ Resume' : '▶ Play'
}

export const sideOf = (shown: Shown, site: string): Shown =>
  player(site).isCompare && shown.compare ? shown.compare : shown
// Each side draws in a picture of its own: a frame of one side swapped into
// the other's picture would keep that one's size and place.
const viewKey = (site: string) => (player(site).isCompare ? 'view-original' : 'view')

const plainAt = (media: Shown, frame: number) =>
  media.frames ? frameFile(media.frames, Math.min(frame, media.frames.count - 1)) : media.path

type Source = { png: string } | { file: string; format: 'png'; generation?: number }

// Claude Code takes at most 2 MiB of picture as bytes: a bigger one is sent as
// a smaller copy, made once with whatever the machine has (sips, ffmpeg or
// ImageMagick) and kept in the temp folder.
const BYTES_MAX = 2_000_000
export const SHRINK_SH = [
  'f="$0"; out="$1"; ff="$2"; max="$3"',
  'size() { wc -c < "$1" | tr -d " "; }',
  '[ "$(size "$f")" -le "$max" ] && { echo "$f"; exit 0; }',
  '[ -s "$out" ] && [ "$(size "$out")" -le "$max" ] && { echo "$out"; exit 0; }',
  'w=1600',
  'while [ "$w" -ge 200 ]; do',
  '  rm -f "$out"',
  '  if command -v sips >/dev/null 2>&1; then sips -s format png --resampleWidth "$w" "$f" --out "$out" >/dev/null 2>&1',
  '  elif [ -x "$ff" ]; then "$ff" -v error -y -i "$f" -vf "scale=$w:-2" "$out" </dev/null 2>/dev/null',
  '  elif command -v magick >/dev/null 2>&1; then magick "$f" -resize "${w}x" "$out" 2>/dev/null',
  '  elif command -v convert >/dev/null 2>&1; then convert "$f" -resize "${w}x" "$out" 2>/dev/null',
  '  else exit 1; fi',
  '  [ -s "$out" ] && [ "$(size "$out")" -le "$max" ] && { echo "$out"; exit 0; }',
  '  w=$((w * 3 / 4))',
  'done',
  'exit 1',
].join('\n')
const fitted = new Map<string, string>()
// The last few pictures read, so a button press that redraws the player
// doesn't read and send its picture from disk again.
const recentBytes = new Map<string, string>()
async function bytesOf($: EngineInterface, file: string): Promise<string | null> {
  const known = recentBytes.get(file)
  if (known) return known
  const png = await readBytes($, file)
  if (png) {
    recentBytes.set(file, png)
    if (recentBytes.size > 6) recentBytes.delete(recentBytes.keys().next().value!)
  }
  return png
}
async function readBytes($: EngineInterface, file: string): Promise<string | null> {
  // Most files (every video frame) are under the limit: read them as they are,
  // with no process started per frame.
  if (!fitted.has(file)) {
    const direct = await Promise.resolve().then(() => $.fs.read(file, { as: 'bytes' })).catch(() => null)
    if (direct?.base64 && direct.base64.length * 0.75 <= BYTES_MAX) return direct.base64
  }
  let small = fitted.get(file)
  if (!small) {
    const r = await Promise.resolve().then(() => $.process.run(['sh', '-c', SHRINK_SH, file, `${state.TMP}/b-${keyOf(file)}.png`, state.ffmpeg, String(BYTES_MAX)])).catch(() => null)
    small = r?.exitCode === 0 ? r.stdout.trim() : ''
    if (!small) return null
    fitted.set(file, small)
  }
  const loaded = await Promise.resolve().then(() => $.fs.read(small!, { as: 'bytes' })).catch(() => null)
  return loaded?.base64 ?? null
}
// Orca reads a picture file only from a temp folder or the terminal's own
// worktree, and only up to 2 MiB; its floating terminal has no worktree. A
// file it refuses draws as an empty box, and nothing comes back to say so. So
// in Orca a picture outside the temp folder is drawn from a copy there, and
// one too big from a smaller copy.
export const orcaReads = (file: string, bytes: number, tmp: string) => file.startsWith(`${tmp}/`) && bytes <= BYTES_MAX
// One copy per picture, and two draws at once share it. A picture is known by
// its path, size and time, not its path alone: a file saved again, or a temp
// name like `shot-3.png` back with another picture in it, gets a new copy. A
// file Orca reads as it is (every video frame) gets none.
const orcaCopies = new Map<string, Promise<string>>()
async function orcaFile($: EngineInterface, file: string): Promise<string> {
  const st = await Promise.resolve().then(() => $.fs.stat(file)).catch(() => null)
  if (!st || orcaReads(file, st.size, state.TMP)) return file
  const id = keyOf(`${file}|${st.size}|${st.mtimeMs}`)
  let made = orcaCopies.get(id)
  if (!made) orcaCopies.set(id, (made = orcaCopy($, file, st.size, id)))
  return made
}
async function orcaCopy($: EngineInterface, file: string, size: number, id: string): Promise<string> {
  if (size > BYTES_MAX) {
    const r = await Promise.resolve().then(() => $.process.run(['sh', '-c', SHRINK_SH, file, `${state.TMP}/b-${id}.png`, state.ffmpeg, String(BYTES_MAX)])).catch(() => null)
    return (r?.exitCode === 0 && r.stdout.trim()) || file
  }
  const copy = `${state.TMP}/o-${id}.png`
  // `cp -c` keeps the original's time; the temp folder's cleanup goes by it.
  const r = await Promise.resolve().then(() => $.process.run(['sh', '-c', '{ cp -c "$0" "$1" 2>/dev/null || cp --reflink=auto "$0" "$1" 2>/dev/null || cp "$0" "$1"; } && touch "$1"', file, copy])).catch(() => null)
  return r?.exitCode === 0 ? copy : file
}
export async function pngSource($: EngineInterface, file: string): Promise<Source> {
  if (state.sendBytes) {
    const png = await bytesOf($, file)
    if (png) return { png }
  }
  if (state.terminalName === 'orca') return { file: await orcaFile($, file), format: 'png' as const }
  return { file, format: 'png' as const }
}

// What draws a picture: the Image's source.
type Pic = { src: Source }

async function picFor($: EngineInterface, file: string, _box: { columns: number; rows: number }): Promise<Pic> {
  return { src: await pngSource($, file) }
}

// After a first draw, asks whether the picture really drew; if the terminal
// can only show the alt text, switches every picture to cells.
function probe($: EngineInterface, site: string, key: string, pic: Pic) {
  if (!state.canImage || state.probed) return
  state.probed = true
  void $.clock.sleep(250).then(async () => {
    // A video playing by now shows a later frame: send that one, not the
    // poster, or the clip jumps back to its start for a moment.
    const shownNow = swaps.get(`${site}|${key}`)?.last
    const r = await $.ui.blit({ requestId: site, key, source: shownNow ? await pngSource($, shownNow) : pic.src })
    if (r.deny && /alt/i.test(r.deny)) {
      state.canImage = false
      state.drawCause = causeOf(state.inTmux, state.terminalName, state.isForced)
      track('cannot_draw', { cause: state.drawCause })
      $.ui.toast("Pictures can't show here: see the notice in the chat.")
      redraw($)
    }
  }, () => undefined)
}

// One swap at a time per picture, the newest frame winning: a slow swap is
// never overtaken by the next (frames drawn out of order) and never queues
// up behind it (playback falling further behind each frame).
// Each draw takes a ticket; one whose frame was ready later than a newer
// draw's is stale and skipped.
const swaps = new Map<string, { isBusy: boolean; ticket: number; next?: { file: string; frame: number }; last?: string }>()
let tickets = 0
async function blit($: EngineInterface, site: string, key: string, media: Shown, file: string, frame: number, ticket = ++tickets) {
  if (!state.canImage) return
  const id = `${site}|${key}`
  let lane = swaps.get(id)
  if (!lane) swaps.set(id, (lane = { isBusy: false, ticket: 0 }))
  if (ticket < lane.ticket) return void debug(`stale frame=${frame}`)
  lane.ticket = ticket
  if (lane.isBusy) {
    if (lane.next) debug(`drop frame=${lane.next.frame}`)
    lane.next = { file, frame }
    return
  }
  lane.isBusy = true
  let job: { file: string; frame: number } | undefined = { file, frame }
  try {
    while (job) {
      const at = Date.now()
      await $.ui.blit({ requestId: site, key, source: await pngSource($, job.file) })
      noteDrawn(site, media.width, media.height)
      lane.last = job.file
      debug(`blit frame=${job.frame} ms=${Date.now() - at}`)
      job = lane.next
      lane.next = undefined
    }
  } finally {
    lane.isBusy = false
  }
}

// A kitty-protocol terminal keeps pictures it was sent up to its image
// storage limit and drops the oldest past it: 320 MB of decoded pixels by
// default in Ghostty and kitty. A picture is only re-sent on scrolling back
// when enough has been sent since that it may have been dropped; otherwise
// the terminal still has it and it shows at once. Half that limit, for
// margin; a terminal whose limit isn't known (Warp and others) gets a smaller
// budget, so it re-sends sooner rather than leave a picture blank.
const MB = 1024 * 1024
const safeBytes = () => (state.terminalName === 'ghostty' || state.terminalName === 'kitty' ? 160 * MB : 48 * MB)
export function noteDrawn(site: string, width: number, height: number) {
  state.drawnBytes += Math.max(0, width * height * 4)
  player(site).drawnAt = state.drawnBytes
}
export function mayBeDropped(site: string) {
  const at = player(site).drawnAt
  return at === undefined || state.drawnBytes - at > safeBytes()
}

export function draw($: EngineInterface, site: string, media: Shown, shown?: Shown) {
  const one = player(site)
  if (one.isSplit && shown?.pair) {
    const at = Math.min(one.frame, shown.pair.count - 1), pair = shown.pair
    const ticket = ++tickets
    void pairReady($, shown, at, site).then(() => blit($, site, 'view-pair', shown, frameFile(pair, at), at, ticket)).catch(() => undefined)
    return
  }
  if (one.isSplit && shown?.compare) {
    const at = compareFrame(shown, one.frame), compare = shown.compare, frame = one.frame
    const ticket = ++tickets
    void frameReady($, compare, at, site).then(() => blit($, site, 'view-a', compare, plainAt(compare, at), at, ticket)).catch(() => undefined)
    void frameReady($, shown, frame, site).then(() => blit($, site, 'view-b', shown, plainAt(shown, frame), frame, ticket)).catch(() => undefined)
    return
  }
  const frame = one.frame
  const ticket = ++tickets
  void frameReady($, media, frame, site).then(() => blit($, site, viewKey(site), media, plainAt(media, frame), frame, ticket)).catch(() => undefined)
}

// A side's checks in words: "4 checks fail" or "all 11 checks pass".
export function resultWords(checks: Check[] = []): string {
  const failing = checks.filter(c => !c.ok).length
  if (!checks.length) return ''
  return failing ? `${failing} ${failing === 1 ? 'check fails' : 'checks fail'}` : `all ${checks.length} checks pass`
}

// The latest check up to a moment whose result differs between the sides.
export function changeAt(shown: Shown, seconds: number): { check: Check; was: boolean } | null {
  const before = new Map((shown.compare?.checks ?? []).map(c => [c.name, c.ok]))
  const differing = (shown.checks ?? []).filter(c => c.at !== undefined && before.has(c.name) && before.get(c.name) !== c.ok && c.at <= seconds)
  const last = differing.at(-1)

  return last ? { check: last, was: before.get(last.name)! } : null
}

export function stop($: EngineInterface, site: string) {
  const one = player(site)
  one.timer?.cancel()
  one.timer = undefined
  redraw($, site)
}

export function play($: EngineInterface, site: string, media: Shown, shown?: Shown) {
  const one = player(site)
  const frames = media.frames
  if (one.timer || !frames) return
  // One video plays at a time: starting this one pauses the rest.
  for (const [other, p] of players) {
    if (other !== site && p.timer) {
      p.timer.cancel()
      p.timer = undefined
      versions.set(other, (versions.get(other) ?? 0) + 1)
    }
  }
  if (one.frame >= frames.count - 1) {
    one.frame = 0
    draw($, site, media, shown)
  }
  // The picture swaps every frame; the bar and the time redraw once a second,
  // or when the change on screen moves on. A redraw repaints every player
  // window in the chat, so it stays rare.
  const timed = inClipOrder(shown?.changes ?? [])
  const isOriginal = !!shown && media !== shown
  const marks = () => {
    const t = one.frame / frames.fps
    return `${Math.floor(t)}|${liveChange(timed, shown && isOriginal ? toUpdated(shown, t) : t, frames.fps)}`
  }
  let last = marks()
  // The clock never runs ahead of the frames: a tick whose next frame is
  // still being cut waits for it, so pressing play never skips ahead.
  let isWaiting = false
  let tickAt = Date.now()
  debug(`play fps=${frames.fps} count=${frames.count} from=${one.frame}`)
  one.timer = $.clock.every(Math.round(1000 / frames.fps), () => {
    debug(`tick gap=${Date.now() - tickAt} frame=${one.frame}${isWaiting ? ' waiting' : ''}`)
    tickAt = Date.now()
    if (one.frame >= frames.count - 1) return stop($, site)
    if (isWaiting) return
    const coming = one.frame + 1
    if (!shown?.pair || !one.isSplit) {
      isWaiting = true
      void frameReady($, media, coming, site).finally(() => { isWaiting = false })
      if (!isFrameCut(media, coming)) return void debug(`wait frame=${coming}`)
      isWaiting = false
    }
    one.frame = coming
    draw($, site, media, shown)
    const now = marks()
    if (now !== last) {
      last = now
      debug('redraw')
      redraw($, site)
    }
  })
  redraw($, site)
}

function toggle($: EngineInterface, site: string, media: Shown, shown?: Shown) {
  return player(site).timer ? stop($, site) : play($, site, media, shown)
}

function seek($: EngineInterface, site: string, media: Shown, seconds: number, shown?: Shown) {
  const frames = media.frames
  if (!frames) return
  player(site).frame = Math.max(0, Math.min(frames.count - 1, Math.round(seconds * frames.fps)))
  draw($, site, media, shown)
  redraw($, site)
}

function flip($: EngineInterface, site: string, shown: Shown, toCompare: boolean) {
  const one = player(site)
  if (!shown.compare || !!one.isCompare === toCompare) return
  const from = sideOf(shown, site)
  const wasPlaying = !!one.timer
  one.timer?.cancel()
  one.timer = undefined
  one.isCompare = toCompare
  const to = sideOf(shown, site)
  // Same moment on the other side, lined up on the steps both runs share.
  // Beside a still picture there's no moment to match: keep the video's place.
  if (toCompare) {
    one.updatedFrame = one.frame
    one.frame = compareFrame(shown, one.frame)
  } else if (from.frames && to.frames) {
    const t = toUpdated(shown, one.frame / from.frames.fps)
    one.frame = Math.max(0, Math.min(to.frames.count - 1, Math.round(t * to.frames.fps)))
  } else one.frame = one.updatedFrame ?? 0
  // A still is drawn by the redraw at its own size; a swap would put it in
  // the other side's box first.
  if (to.frames) draw($, site, to)
  if (wasPlaying && to.frames) play($, site, to, shown)
  redraw($, site)
}

// Side by side: both sides at once, locked to the same moment, the shown
// side's clock driving both.
function split($: EngineInterface, site: string, shown: Shown, isOn: boolean) {
  const one = player(site)
  if (!shown.compare || (isOn && !shown.pair) || !!one.isSplit === isOn) return
  const wasPlaying = !!one.timer
  one.timer?.cancel()
  one.timer = undefined
  if (one.isCompare && shown.compare.frames && shown.frames)
    one.frame = Math.max(0, Math.min(shown.frames.count - 1, Math.round(toUpdated(shown, one.frame / shown.compare.frames.fps) * shown.frames.fps)))
  one.isCompare = false
  one.isSplit = isOn
  if (wasPlaying) play($, site, shown, shown)
  redraw($, site)
}

// The engine's UI components come untyped through $.ui.resolve.
// biome-ignore lint/suspicious/noExplicitAny: the engine gives its UI components no types
export type Ui = any
type Box = { columns: number; rows: number }

// The picture.
function Picture(ui: Ui, $: EngineInterface, site: string, shown: Shown, media: Shown, box: Box, pic: Pic, frame: Box = box) {
  const { Box, Text, Image } = ui
  if (!Image) return <Text dimColor>This surface cannot draw images.</Text>

  // The picture stands alone: no wrapper, nothing laid over it and no fill
  // behind it. Each of those kept the picture from drawing in the terminal.
  // The same file in a box of another size (a resized window) is sent again:
  // the terminal keeps a picture at the size it was last sent at.
  const source = 'file' in pic.src ? { ...pic.src, generation: box.columns * 1000 + box.rows } : pic.src
  const image = (
    <Image
      key={viewKey(site)}
      source={source}
      columns={box.columns}
      rows={box.rows}
      alt={`[${media.kind ?? 'image'}: ${shown.title}]`}
    />
  )
  if (frame.columns === box.columns && frame.rows === box.rows) return image
  // A side smaller than the frame it shares sits centred in it, unfilled.
  return <Box width={frame.columns} height={frame.rows} justifyContent="center" alignItems="center">{image}</Box>
}

// The scrub row: the play control, elapsed, a clickable bar, total — exactly
// as wide as the picture.
function Scrub(ui: Ui, $: EngineInterface, site: string, media: Shown, width: number, shown?: Shown) {
  const { Box, Text, Button } = ui
  const one = player(site)
  const frames = media.frames!
  const word = playWord(!!one.timer, one.frame, frames.count)
  const elapsed = clock(one.frame >= frames.count - 1 ? frames.duration : one.frame / frames.fps)
  const total = clock(frames.duration)
  const segments = Math.max(6, width - (word.length + 4) - elapsed.length - total.length - 4)
  const playhead = Math.min(segments - 1, Math.round((one.frame / Math.max(1, frames.count - 1)) * (segments - 1)))
  one.segments = segments

  // ~20 wide buttons, each a stretch you can jump to, playing or paused: the
  // bar redraws once a second, so the buttons cost little.
  const chunks = barChunks(segments, playhead)

  return (
    <Box flexDirection="row" flexWrap="nowrap" width={width}>
      <Button key="play" variant="primary" label={word} onPress={() => { act(word.includes('Pause') ? 'pause' : 'play'); if (!word.includes('Pause')) tourHeard($, 'play'); toggle($, site, media, shown) }} />
      <Text dimColor> {elapsed} </Text>
      {chunks.map((c, i) => (
        <Button
          key={`seek-${i}`}
          plain
          dimColor={c.isAhead}
          label={c.label}
          onPress={() => { act('scrub'); seek($, site, media, (Math.round((c.start / Math.max(1, segments - 1)) * (frames.count - 1)) + 0.5) / frames.fps, shown) }}
        />
      ))}
      <Text dimColor> {total}</Text>
    </Box>
  )
}

// Splits the bar's cells into ~20 stretches: played cells '━', the playhead
// '●', the rest '─'; a stretch is dim once it lies ahead.
export function barChunks(segments: number, playhead: number, count = 20) {
  const size = Math.max(1, Math.ceil(segments / count))
  const chunks: { start: number; label: string; isAhead: boolean }[] = []
  for (let start = 0; start < segments; start += size) {
    let label = ''
    for (let i = start; i < Math.min(segments, start + size); i++) {
      label += i === playhead ? '●' : i < playhead ? '━' : '─'
    }
    chunks.push({ start, label, isAhead: start > playhead })
  }

  return chunks
}

// Original / Updated / Compare (side by side): the view shown is the accent button.
// The compared side when it is one of several earlier versions: the one
// before by default, with ‹ › to step further back. Versions are numbered
// from the first one shown, so the updated side is the highest.
export function atStep(shown: Shown, site: string): Shown {
  const step = player(site).step
  const picked = step === undefined ? undefined : prepared.get(shown.history?.[step]?.path ?? '')
  return picked ? { ...shown, compare: picked } : shown
}

// Puts an earlier version on the original side, read the first time it is
// picked; the newest entry is the updated side itself.
function pickVersion($: EngineInterface, site: string, shown: Shown, to: number) {
  const history = shown.history!
  const one = player(site)
  if (one.isSplit) split($, site, shown, false)
  const picked = history[to]
  if (!picked) return flip($, site, shown, false)
  void preparedOf($, picked.path).then(version => {
    one.step = to
    if (!one.isCompare) flip($, site, { ...shown, compare: version }, true)
    else draw($, site, version)
    redraw($, site)
  }).catch(() => $.ui.toast('That version is gone'))
}

// With history, which version is on screen, in words: "viewing v1 of 3".
function viewingLabel(shown: Shown, site: string): string {
  const history = shown.history
  const one = player(site)
  if (!history || history.length < 2 || !one.isHistory) return ''
  const total = history.length + 1
  const at = one.isCompare ? (one.step ?? shown.historyAt ?? history.length - 1) + 1 : total
  return at === total ? `· latest, v${total}` : `· viewing v${at} of ${total}`
}

// The player's zones, the same in every view:
//   TitleBar  the title (only it gives way), the side shown, the score, a PR link, the tabs
//   stage     the picture, the scrub bar and the buttons under it
//   Report    what changed or the versions, then QA: beside the stage when wide, else under it
// A tour's instructions sit in the tour's own header, never inside the player.
function TitleBar(ui: Ui, $: EngineInterface, site: string, shown: Shown, at: { width?: number; checks?: Check[]; pr?: Ui }) {
  const { Box, Text } = ui
  const checks = at.checks ?? []
  const passed = checks.filter(c => c.ok).length
  const viewing = viewingLabel(shown, site)
  return (
    <Box key="title-bar" flexDirection="row" justifyContent="space-between" gap={2} width={at.width}>
      <Box flexDirection="row" gap={2} flexShrink={1} flexGrow={1}>
        <Text bold wrap="truncate-end">{shown.title}</Text>
        {viewing && <Text color="suggestion" wrap="truncate-end">{viewing}</Text>}
        {checks.length > 0 && (
          <Text bold color={passed === checks.length ? 'success' : 'error'}>
            {passed === checks.length ? '✓' : '✗'} {passed}/{checks.length}
          </Text>
        )}
      </Box>
      <Box flexDirection="row" gap={2} flexShrink={0}>
        {at.pr}
        {Tabs(ui, $, site, shown)}
      </Box>
    </Box>
  )
}

// The tab row's width: each Button draws as "[ label ]", one apart.
export function tabsWidth(shown: Shown) {
  if (!shown.compare) return 0
  const labels = [tabLabel(shown.compare.label ?? 'Original'), tabLabel(shown.label ?? 'Updated')]
  if (shown.frames && shown.pair) labels.push('⧉ Compare')
  if ((shown.history?.length ?? 0) > 1) labels.push(`History · ${shown.history!.length + 1}`)
  return labels.reduce((n, l) => n + l.length + 4, 0) + labels.length - 1
}
function Tabs(ui: Ui, $: EngineInterface, site: string, shown: Shown) {
  const { Box, Button } = ui
  if (!shown.compare) return null
  const one = player(site)
  // Original, Updated, Compare and History are separate views: one is lit.
  const isHistory = !!one.isHistory
  const isBoth = !isHistory && !!one.isSplit
  const isCompare = !isHistory && !isBoth && !!one.isCompare
  const isUpdated = !isHistory && !isBoth && !isCompare
  const canBoth = !!(shown.frames && shown.pair)
  const hasSteps = (shown.history?.length ?? 0) > 1
  // Original is always the version before; leaving History puts it back.
  const restore = (toCompare: boolean) => {
    const wasStepped = one.step !== undefined && one.step !== shown.historyAt
    one.isHistory = false
    one.step = undefined
    if (one.isSplit) split($, site, shown, false)
    if (wasStepped && one.isCompare) {
      one.isCompare = false
      if (toCompare) flip($, site, shown, true)
      else draw($, site, shown)
    } else flip($, site, shown, toCompare)
    redraw($, site)
  }

  return (
    <Box flexDirection="row" gap={1}>
      <Button key="side-before" variant={isCompare ? 'primary' : 'secondary'} label={tabLabel(shown.compare.label ?? 'Original')} onPress={() => { act('original'); tourHeard($, 'original'); restore(true) }} />
      <Button key="side-after" variant={isUpdated ? 'primary' : 'secondary'} label={tabLabel(shown.label ?? 'Updated')} onPress={() => { act('updated'); restore(false) }} />
      {canBoth && <Button key="side-both" variant={isBoth ? 'primary' : 'secondary'} label="⧉ Compare" onPress={() => { act('compare'); tourHeard($, 'compare'); restore(false); split($, site, shown, true) }} />}
      {hasSteps && (
        <Button key="history" variant={isHistory ? 'primary' : 'secondary'} label={`History · ${shown.history!.length + 1}`}
          onPress={() => { if (isHistory) return restore(false); act('history'); one.isHistory = true; one.changesPage = 0; redraw($, site) }} />
      )}
    </Box>
  )
}

// The QA report beside the picture: the change, its PR, the checks and what
// flipped against the compared side.
// What was fixed or broke; each row jumps to its moment.
function Changes(ui: Ui, $: EngineInterface, site: string, shown: Shown, fixed: Check[], broken: Check[]) {
  const { Box, Button } = ui
  const media = sideOf(shown, site)
  const row = (c: Check, word: string) => (
    <Button
      key={`${word}-${c.name}`}
      plain
      label={`${c.at !== undefined ? `${clock(c.at)} ` : ''}${word} · ${c.name}`}
      onPress={() => { if (c.at === undefined) return; act('check_jump'); seek($, site, media, c.at, shown) }}
    />
  )

  return (
    <Box flexDirection="column">
      {fixed.map(c => row(c, '✓ fixed'))}
      {broken.map(c => row(c, '✗ broke'))}
    </Box>
  )
}

// The QA line on top: how many checks passed, from the summary or the checks.
export function qaTotals(summary: Summary[] = [], checks: Check[] = []) {
  if (summary.some(s => s.total !== undefined)) {
    const total = summary.reduce((n, s) => n + (s.total ?? 0), 0)
    const passed = summary.reduce((n, s) => n + (s.passed ?? (s.ok ? s.total ?? 0 : 0)), 0)
    return { passed, total }
  }
  // Plain lines, a label and a tick each, with no checks to count: one apiece.
  if (!checks.length) return { passed: summary.filter(s => s.ok).length, total: summary.length }

  return { passed: checks.filter(c => c.ok).length, total: checks.length }
}

const PILL = '#30323b'
// The sidebar's top bar, a step lighter than the sidebar.
// Room for a change's title and a QA line, in a column this wide.
const titleWidth = (column: number) => column - 4 /* "12. " */ - 1 - 6 /* " 0:07 " */
const labelWidth = (column: number) => column - 4 /* card border + padding */ - 2 /* "✓ " */ - 5 /* " 11/11" */
// Under the player, what changed and the QA sit side by side from this width.
const TWO_COLUMNS = 72

// Rows the sidebar spends on everything but the change rows.
export function changesThatFit(height: number, summaryRows: number, hasPr: boolean) {
  const qa = summaryRows >= 0 ? 1 /* gap */ + 1 /* label */ + 2 /* card border */ + 1 /* verdict */ + summaryRows : 0
  const fixed = 2 /* padding */ + 1 /* label */ + qa + (hasPr ? 2 : 0)
  return Math.max(1, height - fixed)
}

// The change on screen now: the last one whose moment has come, allowing for
// a seek landing up to half a frame early.
export function liveChange(changes: KeyChange[], now: number, fps: number): number {
  return changes.reduce((hit, c, i) => (c.at !== undefined && c.at <= now + 0.5 / fps ? i : hit), -1)
}

// Changes in the order they show in the clip; ones without a time keep
// their place after the timed ones.
export function inClipOrder(changes: KeyChange[]): KeyChange[] {
  return changes.map((c, i) => ({ c, i })).sort((a, b) => (a.c.at ?? Number.POSITIVE_INFINITY) - (b.c.at ?? Number.POSITIVE_INFINITY) || a.i - b.i).map(x => x.c)
}

// The report: the Original / Updated / Compare switch in a top bar, what changed
// (each one jumps to its moment; the one playing now is lit), the QA in a
// card, then the PR. Text wraps; nothing is cut. Beside the player it is a
// sidebar exactly as tall as the player, paging what doesn't fit; under it (a
// narrow window) it spans the player's width, in two columns when there's room.
function Report(ui: Ui, $: EngineInterface, site: string, shown: Shown, prLink: Ui, at: { width: number; height?: number }) {
  const { Box, Text, Button } = ui
  const one = player(site)
  const media = sideOf(shown, site)
  const { width, height } = at
  const isBeside = height !== undefined
  const isTwo = !isBeside && width - 4 >= TWO_COLUMNS
  const column = isTwo ? Math.floor((width - 4 - 3) / 2) : width - 4
  const TITLE = titleWidth(column), LABEL = labelWidth(column)
  const changes = inClipOrder(shown.changes?.length ? shown.changes : shown.change ? [{ title: shown.change }] : [])
  // The summary is the updated side's; on the original, its own checks count.
  const summary = (media === shown ? shown.summary ?? [] : []).slice(0, 3).map(s => ({ ...s, lines: wrapWords(s.label, LABEL) }))
  const { passed, total } = qaTotals(summary, media.checks)
  const allPass = total > 0 && passed === total
  const summaryRows = summary.reduce((n, s) => n + s.lines.length, 0)
  const room = isBeside ? changesThatFit(height, total > 0 ? summaryRows : -1, !!prLink) : Number.POSITIVE_INFINITY
  const wrapped = changes.map((c, n) => ({ c, n, lines: wrapWords(c.title, TITLE) }))
  const pages = pagesOf(wrapped.map((w, i) => ({ item: w, rows: w.lines.length + (i ? 1 : 0) })), room)
  const page = Math.min(one.changesPage ?? 0, pages.length - 1)
  // Changes are timed on the updated clip; on the original, map the clock.
  const onOriginal = media !== shown
  const now = media.frames ? (onOriginal ? toUpdated(shown, one.frame / media.frames.fps) : one.frame / media.frames.fps) : -1
  const live = liveChange(changes, now, media.frames?.fps ?? 12)
  const label = (text: string, right?: Ui) => (
    <Box flexDirection="row" justifyContent="space-between">
      <Text dimColor bold>{text}</Text>
      {right}
    </Box>
  )

  const changed = (
    <Box flexDirection="column" width={column}>
      {label(
        `${(shown.changesTitle || 'What changed').toUpperCase()} · ${changes.length}`,
        pages.length > 1 ? (
          <Button
            key="changes-more"
            plain
            dimColor
            label={`${page + 1}/${pages.length} ${page === pages.length - 1 ? '↑' : '↓'}`}
            onPress={() => {
              one.changesPage = (page + 1) % pages.length
              redraw($, site)
            }}
          />
        ) : undefined,
      )}
      {(pages[page] ?? []).map(({ c, n, lines }, k) => {
        const isLive = n === live
        // A change pauses on its moment, to be looked at; Play goes on from there.
        const jump = () => { if (c.at === undefined) return; act('change_jump'); tourHeard($, 'change_jump'); stop($, site); seek($, site, media, onOriginal ? toOriginal(shown, c.at) : c.at, shown) }
        return (
          <Box key={`change-${n}`} flexDirection="row" gap={1} marginTop={k ? 1 : 0}>
            <Text color={isLive ? 'suggestion' : undefined} dimColor={!isLive}>{`${n + 1}.`.padStart(3)}</Text>
            <Box flexDirection="column" width={TITLE}>
              {lines.map((line, i) =>
                c.at !== undefined
                  ? <Button key={`change-${n}-${i}`} plain label={line} hover={{ inverse: true }} onPress={jump} />
                  : <Text key={`change-${n}-${i}`}>{line}</Text>,
              )}
            </Box>
            {c.at !== undefined && (
              <Text backgroundColor={isLive ? 'suggestion' : PILL} color={isLive ? 'inverseText' : undefined}>
                {` ${clock(c.at)} `}
              </Text>
            )}
          </Box>
        )
      })}
    </Box>
  )
  // The versions, newest first, each by what changed in it; the one on the
  // original side is lit, and a click puts another there.
  const history = one.isHistory ? shown.history : undefined
  const onSide = one.isCompare ? one.step ?? shown.historyAt ?? (history?.length ?? 1) - 1 : (history?.length ?? 0)
  const versions = history ? [...history, { path: '', note: shown.note }].map((v, i) => ({ v, i })).reverse() : []
  // Each version one line, so a long note and a one-word one line up alike.
  // Room for " viewing " (9) beside the label, as TITLE leaves room for a time.
  const VERSION = column - 4 - 1 - 9
  const listed = versions.map(({ v, i }) => ({ i, lines: [oneLine(v.note || (i === history!.length ? 'This version' : `Version ${i + 1}`), VERSION)] }))
  const versionPages = pagesOf(listed.map((w, k) => ({ item: w, rows: w.lines.length + (k ? 1 : 0) })), room)
  const versionPage = Math.min(one.changesPage ?? 0, versionPages.length - 1)
  const versionList = history && (
    <Box flexDirection="column" width={column}>
      {label(
        `VERSIONS · ${versions.length}`,
        versionPages.length > 1 ? (
          <Button key="versions-more" plain dimColor label={`${versionPage + 1}/${versionPages.length} ${versionPage === versionPages.length - 1 ? '↑' : '↓'}`}
            onPress={() => { one.changesPage = (versionPage + 1) % versionPages.length; redraw($, site) }} />
        ) : undefined,
      )}
      {(versionPages[versionPage] ?? []).map(({ i, lines }, k) => {
        const isOn = i === onSide
        const isLatest = i === history.length
        return (
          <Box key={`version-${i}`} flexDirection="row" gap={1} marginTop={k ? 1 : 0}>
            <Text color={isOn ? 'suggestion' : undefined} dimColor={!isOn}>{`${i + 1}.`.padStart(3)}</Text>
            <Box flexDirection="column" width={VERSION}>
              {lines.map((line, j) => (
                <Button key={`version-${i}-${j}`} plain label={line} hover={{ inverse: true }} onPress={() => { act('version_pick'); tourHeard($, 'version_pick'); pickVersion($, site, shown, i) }} />
              ))}
            </Box>
            {(isOn || isLatest) && (
              <Text backgroundColor={isOn ? 'suggestion' : PILL} color={isOn ? 'inverseText' : undefined}>
                {isOn ? ' viewing ' : ' latest '}
              </Text>
            )}
          </Box>
        )
      })}
    </Box>
  )
  const qa = total > 0 && (
    <Box flexDirection="column" width={column} marginTop={isTwo ? 0 : 1}>
      {label('QA', <Text bold color={allPass ? 'success' : 'error'}>{passed}/{total}</Text>)}
      <Box flexDirection="column" borderStyle="round" borderColor={allPass ? 'success' : 'error'} borderDimColor paddingX={1}>
        <Text bold color={allPass ? 'success' : 'error'}>
          {allPass ? '✓ All checks passed' : `✗ ${total - passed} of ${total} checks failed`}
        </Text>
        {summary.map(s => (
          <Box key={`sum-${s.label}`} flexDirection="row" gap={1}>
            <Text color={s.ok ? 'success' : 'error'}>{s.ok ? '✓' : '✗'}</Text>
            <Box flexDirection="column" width={LABEL}>
              {s.lines.map((line, i) => <Text key={`sum-${s.label}-${i}`}>{line}</Text>)}
            </Box>
            {s.total !== undefined && <Text dimColor>{`${s.passed ?? (s.ok ? s.total : 0)}/${s.total}`.padStart(5)}</Text>}
          </Box>
        ))}
      </Box>
    </Box>
  )

  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden" backgroundColor={SIDEBAR}>
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        {versionList || (
          <Box flexDirection="column">
            {changes.length > 0 && (isTwo ? <Box flexDirection="row" gap={3}>{changed}{qa}</Box> : changed)}
            {(!isTwo || !changes.length) && qa}
          </Box>
        )}
        {prLink && <Box flexDirection="row" gap={1} marginTop={1}><Text dimColor>PR</Text>{prLink}</Box>}
      </Box>
    </Box>
  )
}

// Scratch output lives in temp folders; finished work lives somewhere real.
export const isScratch = (path: string) => /^\/(private\/)?(tmp|var\/folders)\//.test(path)

// What you do with the file: watch it properly, keep it (or find it), or
// paste its path elsewhere.
function Actions(ui: Ui, $: EngineInterface, media: Shown, source: string, isNarrow: boolean) {
  const { Box, Button } = ui
  const done = (r: { exitCode: number; stderr: string }, note: string, what: string, path: string) =>
    $.ui.toast(r.exitCode === 0 ? note : openFailure(r, what, path))
  const name = source.split('/').pop()!
  const keep = async () => {
    // A free name: "clip.mp4", then "clip 2.mp4", "clip 3.mp4"…
    const dot = name.lastIndexOf('.')
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
    let out = `${state.home}/Downloads/${name}`
    for (let n = 2; await $.fs.stat(out).then(() => true, () => false); n++) out = `${state.home}/Downloads/${stem} ${n}${ext}`
    if (!state.isMac) await $.process.run(['mkdir', '-p', `${state.home}/Downloads`])
    const r = await $.process.run(['cp', source, out])
    if (r.exitCode !== 0) return $.ui.toast(`Couldn't save it to Downloads: ${r.stderr.trim().split('\n')[0]?.slice(0, 100) || `error ${r.exitCode}`}`)
    // Saved either way; the folder opening is a convenience on top.
    await $.process.run(state.isMac ? ['open', '-R', out] : openArgv(`${state.home}/Downloads`)).catch(() => undefined)
    $.ui.toast(`Saved to Downloads/${out.split('/').pop()}`)
  }

  return (
    <Box flexDirection="row" gap={2}>
      {!source.startsWith(`${state.home}/Downloads/`) ? (
        <Button key="keep" plain dimColor label="Save to Downloads" onPress={() => { act('save'); void keep() }} />
      ) : (
        <Button key="reveal" plain dimColor label={state.isMac ? 'Show in Finder' : 'Show in folder'} onPress={() => act('reveal') || void $.process.run(state.isMac ? ['open', '-R', source] : openArgv(source.slice(0, source.lastIndexOf('/')) || '/')).then(r => done(r, state.isMac ? 'Shown in Finder' : 'Opened the folder', 'folders', source))} />
      )}
      {!isNarrow && (
        <Button
          key="copy"
          plain
          dimColor
          label="Copy path"
          onPress={(press: { surface: 'terminal' }) =>
            act('copy_path') || void $.ui.copy({ text: source, surface: press.surface }).then(r => $.ui.toast(r.isCopied ? 'Path copied' : 'Could not copy the path'))
          }
        />
      )}
    </Box>
  )
}

// The page the moment shows: the latest check's url up to now, else the item's.
export function urlAt(shown: Shown, seconds: number): string | undefined {
  const hit = (shown.checks ?? []).filter(c => c.url && (c.at ?? 0) <= seconds).at(-1)

  return hit?.url ?? shown.url
}

// Shown while pictures are drawn as cells: why, and the way back to full quality.
// Resumes this chat outside the background service, so pictures draw again.
// A session still running in the background can't be resumed: it's stopped first.
export const resumeCommand = (id: string) =>
  id ? `claude stop ${id}; CLAUDE_CODE_DISABLE_AGENT_VIEW=1 claude --resume ${id}` : 'CLAUDE_CODE_DISABLE_AGENT_VIEW=1 claude --resume'

// Why pictures can't draw here, once a draw has failed: tmux blocking them,
// a terminal without picture support, a background session, or a terminal
// where Claude Code leaves pictures off until they're turned on.
export type DrawCause = 'tmux' | 'herdr' | 'terminal' | 'background' | 'off'

// Claude Code turns pictures on by itself only in Ghostty and kitty. Warp,
// WezTerm and Konsole draw them too, but only when
// CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1 is set before Claude Code starts: Claude
// Code reads it at launch, so a plugin can't set it for the running session.
// Turn on pictures adds one line to the person's shell profile that sets it
// only inside that terminal, so other terminals are unaffected.
export const SWITCHABLE: Record<string, { label: string; sh: string; fish: string }> = {
  warp: { label: 'Warp', sh: '[ "$TERM_PROGRAM" = "WarpTerminal" ]', fish: 'test "$TERM_PROGRAM" = WarpTerminal' },
  wezterm: { label: 'WezTerm', sh: '[ "$TERM_PROGRAM" = "WezTerm" ]', fish: 'test "$TERM_PROGRAM" = WezTerm' },
  konsole: { label: 'Konsole', sh: '[ -n "$KONSOLE_VERSION" ]', fish: 'test -n "$KONSOLE_VERSION"' },
}
// Marks the line, so it is found again to skip a second copy or to remove it.
export const PROFILE_MARK = '# show-your-work: pictures in '

// The profile file the person's login shell reads, from $SHELL. Null for a
// shell this doesn't know: the notice then shows the line to add by hand.
export function profileOf(shell: string, home: string, isMac: boolean): string | null {
  const name = shell.split('/').pop() ?? ''
  if (name === 'zsh') return `${home}/.zshrc`
  if (name === 'bash') return isMac ? `${home}/.bash_profile` : `${home}/.bashrc`
  if (name === 'fish') return `${home}/.config/fish/config.fish`
  return null
}

// The line itself, in the shell's own syntax.
export function profileLine(terminal: string, shell: string): string {
  const t = SWITCHABLE[terminal]!
  const mark = `${PROFILE_MARK}${t.label}`
  return /fish$/.test(shell)
    ? `if ${t.fish}; set -gx CLAUDE_CODE_FORCE_TERMINAL_IMAGES 1; end ${mark}`
    : `if ${t.sh}; then export CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1; fi ${mark}`
}

// Turn on pictures: appends the line once, then the notice says to restart.
// When the shell or its profile can't be written, the notice shows the line
// to add by hand instead.
export async function turnOnPictures($: EngineInterface) {
  act('turn_on_pictures')
  const shell = (await $.env.get('SHELL')) ?? ''
  const profile = profileOf(shell, state.home, state.isMac)
  const line = profileLine(state.terminalName, shell)
  if (!profile) return $.ui.toast(`Add this line to your shell profile, then restart Claude Code: ${line}`)
  const before = await $.fs.read(profile).catch(() => '')
  if (!before.includes(`${PROFILE_MARK}${SWITCHABLE[state.terminalName]!.label}`)) {
    const written = await $.fs.write(profile, `${before}${before && !before.endsWith('\n') ? '\n' : ''}${line}\n`).then(() => true, () => false)
    if (!written) return $.ui.toast(`Couldn't write ${profile}. Add this line to it, then restart Claude Code: ${line}`)
  }
  state.isTurnedOn = true
  state.isTurnedOff = false
  redraw($)
}

// Turn pictures off again (the settings row): removes the marked line.
export async function turnOffPictures($: EngineInterface) {
  act('turn_off_pictures')
  const profile = profileOf((await $.env.get('SHELL')) ?? '', state.home, state.isMac)
  const label = SWITCHABLE[state.terminalName]?.label
  if (profile && label) {
    const before = await $.fs.read(profile).catch(() => '')
    const after = before.split('\n').filter(l => !l.includes(`${PROFILE_MARK}${label}`)).join('\n')
    if (after !== before) await $.fs.write(profile, after).catch(() => undefined)
  }
  state.isTurnedOn = false
  state.isTurnedOff = true
  redraw($)
}

// At session start: whether the person turned pictures on in an earlier
// session, read from the line in their shell profile. A tab opened before the
// line was added doesn't have the setting, but pictures are still on.
export async function readPicturesLine($: EngineInterface) {
  const label = SWITCHABLE[state.terminalName]?.label
  const profile = profileOf((await $.env.get('SHELL')) ?? '', state.home, state.isMac)
  if (!label || !profile) return
  const text = await $.fs.read(profile).catch(() => '')
  state.isTurnedOn = text.includes(`${PROFILE_MARK}${label}`)
}

// Whether pictures are on for this terminal, as the settings row shows it.
export const arePicturesOn = () => !state.isTurnedOff && (state.isForced || state.isTurnedOn)
// Terminals that speak the kitty graphics protocol: a failed draw in one of
// them is a background session, not the terminal.
export const KITTY_TERMINALS = ['ghostty', 'kitty', 'wezterm', 'warp', 'konsole']
// Herdr, like tmux, sits between Claude Code and the terminal: pictures get
// through only with its kitty graphics pass-through on, to a terminal that
// draws them.
export const causeOf = (tmux: boolean, terminal: string, isForced = false): DrawCause =>
  tmux ? 'tmux'
    : terminal === 'herdr' ? 'herdr'
    : SWITCHABLE[terminal] ? (isForced ? 'terminal' : 'off')
    : KITTY_TERMINALS.includes(terminal) ? 'background'
    : 'terminal'

// Which terminal this is, from what each one sets in the environment.
export function terminalOf(env: { program: string; term: string; kitty: boolean; konsole: boolean }): string {
  const { program, term } = env
  if (/ghostty/i.test(program + term)) return 'ghostty'
  if (/kitty/i.test(term) || env.kitty) return 'kitty'
  if (/wezterm/i.test(program)) return 'wezterm'
  if (/warp/i.test(program)) return 'warp'
  if (env.konsole) return 'konsole'
  return program.toLowerCase() || 'other'
}

// The notice for a picture that couldn't draw, and the line Claude reads.
// The README's list of terminals that draw pictures.
const TERMINALS = 'https://github.com/iamumeransari/claude-show-your-work#terminals'

export function cantDraw(cause: DrawCause, name: string, kind: 'picture' | 'video', id: string) {
  const what = kind === 'video' ? 'videos' : 'pictures'
  const label = SWITCHABLE[state.terminalName]?.label ?? 'this terminal'
  // Turned on, but this session started without the setting. A new tab reads
  // the shell profile and has it; this tab's shell started before the line
  // was added, so the command sets it for this one restart too.
  if (cause === 'off' && state.isTurnedOn) return {
    title: 'Pictures are on',
    text: 'Type /exit, then paste the command here to see them now. It reopens this chat where you left off. New terminal tabs show pictures on their own.',
    command: `env CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1 claude --resume${id ? ` ${id}` : ''}`, label: 'Copy restart command', action: 'copy_resume_command', isCalm: true,
    claude: `pictures are turned on for ${label}, but this session started before that, so the person saw a notice instead of ${name}. They can type /exit and run the copied command, or open a new terminal tab.`,
  }
  if (cause === 'off') return {
    title: `Pictures are off in ${label}`,
    text: 'Turn them on to see pictures and videos here.',
    command: '', label: 'Turn on pictures', action: 'turn_on_pictures', isCalm: true,
    claude: `pictures are off in ${label} until the person presses Turn on pictures in the notice and restarts Claude Code, so they saw a notice instead of ${name}.`,
  }
  if (cause === 'tmux') return {
    title: `tmux is blocking ${what}`,
    text: `"${name}" is ready, but tmux stops ${what} from reaching the terminal. Add this line to ~/.tmux.conf, reload tmux, and ask Claude to show it again. Or open this chat outside tmux.`,
    command: 'set -g allow-passthrough on', label: 'Copy setting', action: 'copy_tmux_setting',
    claude: `tmux is blocking pictures, so the person saw a notice instead of ${name}. They can add "set -g allow-passthrough on" to ~/.tmux.conf or open the chat outside tmux.`,
  }
  if (cause === 'herdr') return {
    title: `Herdr isn't passing ${what} through`,
    text: `"${name}" is ready, but Herdr isn't passing ${what} on to your terminal. Add this to your Herdr config, restart Herdr, and ask Claude to show it again. The terminal around Herdr also has to support the kitty graphics protocol, such as Ghostty, kitty, WezTerm, Warp or Konsole.`,
    command: '[terminal]\nkitty_graphics = true', label: 'Copy setting', action: 'copy_herdr_setting',
    claude: `Herdr isn't passing pictures through, so the person saw a notice instead of ${name}. They can set kitty_graphics = true under [terminal] in their Herdr config and restart Herdr, in a terminal that supports the kitty graphics protocol.`,
  }
  if (cause === 'terminal') return {
    title: "Your terminal isn't supported by show-your-work",
    text: `"${name}" is ready, but this terminal can't draw ${what}. show-your-work works in any terminal that supports the kitty graphics protocol, such as Ghostty, kitty, WezTerm, Warp or Konsole. See the full list:`,
    link: { href: TERMINALS, after: 'Then press Copy command and paste it in one of them to open this chat there.' },
    command: `claude --resume${id ? ` ${id}` : ''}`, label: 'Copy command', action: 'copy_resume_command',
    claude: `this terminal can't draw pictures, so the person saw a notice instead of ${name}. They need a terminal that supports the kitty graphics protocol, such as Ghostty, kitty, WezTerm, Warp or Konsole (list at ${TERMINALS}).`,
  }
  return {
    title: `Can't show ${what} in a background session`,
    text: `"${name}" is ready, but this chat is running as a background session, and those can't draw ${what} in the terminal. Press Copy command and paste it in a normal terminal tab to reopen it there.`,
    command: resumeCommand(id), label: 'Copy command', action: 'copy_resume_command',
    claude: `this chat runs as a background session, which can't draw pictures, so the person saw a notice instead of ${name}. They can resume the chat in a normal terminal tab to see it.`,
  }
}

function Warning(ui: Ui, $: EngineInterface, site: string, shown: Shown, width: number) {
  const n = cantDraw(state.drawCause, shown.title, shown.frames ? 'video' : 'picture', state.sessionId)
  if (n.action === 'turn_on_pictures') return NoticeBox(ui, $, width, { ...n, copy: '', onPress: () => void turnOnPictures($) })
  return NoticeBox(ui, $, width, { ...n, copy: n.command })
}

// The file behind a preview is gone (temp cleared, cache trimmed, or the
// original moved): say so in place of a blank box, with a prompt to paste.
export function expiredPrompt(shown: Shown): string {
  const file = shown.origin ?? shown.source ?? shown.path
  const kind = shown.frames ? 'video' : 'image'
  return `The ${kind} preview "${shown.title}" expired (${file} is gone). Please regenerate it and show it to me again with show_${kind}${shown.compare ? ', with the same compare' : ''}${shown.changes?.length ? ' and the same list of changes' : ''}.`
}
function Expired(ui: Ui, $: EngineInterface, shown: Shown, width: number) {
  return NoticeBox(ui, $, width, {
    title: 'This preview has expired',
    text: `Previews are cleared after a while to save space. To see "${shown.title}" again, copy the prompt and paste it to Claude.`,
    copy: expiredPrompt(shown), label: 'Copy prompt', action: 'copy_expired_prompt', isCalm: true,
  })
}

// A failure, drawn in place of the picture: what happened, in plain words,
// and one button that copies what to paste back (a prompt, or a command).
// isCalm: something that happens by design (an expired preview), drawn
// plainly; the warning colour and ⚠ are kept for real problems.
export function NoticeBox(ui: Ui, $: EngineInterface, width: number, n: { title: string; text: string; command?: string; copy: string; label: string; action: string; link?: { href: string; after: string }; isCalm?: boolean; onPress?: () => void }) {
  const { Box, Text, Button, Link } = ui
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={n.isCalm ? 'subtle' : 'warning'} paddingX={2} paddingY={1} width={Math.max(40, Math.min(width, 96))}>
      {n.isCalm ? <Text bold>{n.title}</Text> : <Text bold color="warning">⚠ {n.title}</Text>}
      <Text wrap="wrap">{'\n'}{n.text}</Text>
      {n.link ? <Box marginTop={1}><Link href={n.link.href} /></Box> : null}
      {n.link ? <Text wrap="wrap">{'\n'}{n.link.after}</Text> : null}
      {/* A resume command is long and only ever pasted: the button copies it, unseen. */}
      {n.command && n.action !== 'copy_resume_command' && !n.onPress ? <Box marginTop={1}><Text bold>{n.command}</Text></Box> : null}
      <Box flexDirection="row" gap={2} marginTop={1}>
        <Button
          key={n.action}
          variant="primary"
          label={n.label}
          onPress={(press: { surface: 'terminal' }) =>
            n.onPress ? n.onPress() : act(n.action) || void $.ui.copy({ text: n.copy, surface: press.surface }).then(r => $.ui.toast(r.isCopied ? (n.command ? 'Copied. Paste it in your terminal.' : 'Copied. Paste it to Claude.') : 'Could not copy'))
          }
        />
      </Box>
    </Box>
  )
}

// The player: concept A (picture, scrub row, controls) everywhere; concept B
// (A plus the QA report at its side) when there is a report and room for it.
export async function Viewer(
  $: EngineInterface,
  e: Parameters<EngineInterface['ui']['resolve']>[0],
  shown: Shown,
  site: string,
  isPane: boolean,
  viewport: { columns: number; rows: number } | undefined,
) {
  const ui = $.ui.resolve(e) as Ui
  const { Box, Text, Button, Link } = ui
  const one = player(site)
  const media = sideOf(shown, site)
  const frames = media.frames
  const source = media.origin ?? media.source ?? media.path
  const columns = viewport?.columns ?? 100
  const hasReport = !!(shown.change || shown.changes?.length || shown.summary?.length || shown.checks?.length || (one.isHistory && shown.history))
  const layout = layoutOf({ columns, rows: viewport?.rows ?? 40, isPane, hasReport })
  const isWide = layout.isWide
  const other = shown.compare ? (media === shown ? shown.compare : shown) : null
  for (const side of [media, other]) if (side) useSharpest(side)
  // A side short of pixels for its box gets a sharper copy, made in the background.
  if (state.cell) for (const side of [media, other]) if (side) sharpen($, side, pixelsFor(targetBox(side.width, side.height, layout, state.cell), state.cell, side.width / side.height))
  // This side's own box, and the frame it sits in: Original and Updated
  // share the larger of their two boxes, so switching never moves the layout
  // and each side draws whole at its own size, centred.
  const own = drawBox(media.width, media.height, layout, state.cell)
  const theirs = other ? drawBox(other.width, other.height, layout, state.cell) : own
  const box = { columns: Math.max(own.columns, theirs.columns), rows: Math.max(own.rows, theirs.rows) }
  // A new window or font size: the cell is measured again, and only a cell
  // that really changed redraws.
  const size = `${columns}x${viewport?.rows ?? 0}`
  if (cellFor !== size) {
    cellFor = size
    void $.clock.sleep(0).then(() => remeasure($)).then(isChanged => { if (isChanged) redraw($) }, () => undefined)
  }
  // Copy path is dropped only when the row under the picture has no room for
  // it. The row is as wide as the controls, not the picture: a tall, thin
  // picture still has a full row of buttons under it.
  const actionsRow = Math.max(box.columns, Math.min(Math.max(CONTROLS_MIN, tabsWidth(shown) + 14), columns - 8))
  const isNarrow = actionsRow < (frames ? 50 : 38)
  // Under the player the report takes at least a readable width, even beside a tall, thin picture.
  const below = hasReport && !isWide ? Math.max(box.columns, Math.min(layout.inner, 72)) : box.columns
  const checks = media.checks ?? []
  const passed = checks.filter(c => c.ok).length
  const prNumber = shown.pr?.match(/\/pull\/(\d+)/)?.[1]
  const prLabel = prNumber ? `PR #${prNumber}` : shown.pr
  const prLink = shown.pr
    ? /^https?:\/\//.test(shown.pr)
      ? <Link href={shown.pr} label={prLabel} />
      : <Text color="suggestion">{prLabel}</Text>
    : null
  const run = (argv: string[], note: string) => () => {
    void $.process.run(argv).then(r => $.ui.toast(r.exitCode === 0 ? note : `Could not: ${r.stderr.trim()}`))
  }
  // A video the agent shows starts playing by itself, once.
  if (frames && !isPane && !one.hasAutoplayed && freshCalls.has(site)) {
    one.hasAutoplayed = true
    void $.clock.sleep(400).then(() => play($, site, media, shown), () => undefined)
  }

  // The single view with the QA sidebar is the default; side by side is a click away.
  if (!state.canImage) {
    one.timer?.cancel()
    one.timer = undefined
    return Warning(ui, $, site, shown, columns - 8)
  }
  one.box = { columns: own.columns, rows: own.rows }
  await frameReady($, media, one.frame, site)
  // Only expired when the original is gone: a video's frames that were cleaned
  // away are cut again from it.
  if ((await isGone($, plainAt(media, one.frame))) && !(await recutFrame($, media, one.frame))) {
    one.timer?.cancel()
    one.timer = undefined
    return Expired(ui, $, shown, columns - 8)
  }
  const pic = await picFor($, plainAt(media, one.frame), own)
  probe($, site, viewKey(site), pic)
  if (one.isSplit && shown.pair && frames) return SplitView(ui, $, site, shown, columns, viewport?.rows ?? 40, isPane, prLink)

  const actions = Actions(ui, $, media, source, isNarrow)
  // The top corner opens it: the page it shows, else the file itself.
  // Only a web address opens as a page: a model's url could name an app, a
  // script or an option for `open`.
  const at = urlAt(media, frames ? one.frame / frames.fps : 0)
  const page = (at && /^https?:\/\/[^\s]+$/i.test(at) ? at : undefined) ?? (/\.html?$/i.test(source) ? source : undefined)
  const opener = (
    <Button
      key="page"
      plain
      label={page ? '↗ Open page' : '↗ View'}
      onPress={() =>
        act(page ? 'open_page' : 'open_file') || void $.process.run(openArgv(page ?? source)).then(r =>
          $.ui.toast(r.exitCode === 0 ? `Opened ${(page ?? source.split('/').pop()!).slice(0, 60)}` : openFailure(r, page ? 'web pages' : media.kind === 'video' ? 'videos' : 'pictures', page ?? source)),
        )
      }
    />
  )

  // A tall, narrow picture still gets control rows wide enough to read on one
  // line each; the picture sits centred above them.
  // ...but never wider than the window has room for.
  // At least the controls' width, and the title bar's tabs with a little title.
  const controlsMin = Math.min(Math.max(CONTROLS_MIN, tabsWidth(shown) + 14), columns - 8)
  const rowWidth = Math.max(box.columns, controlsMin)
  const stage = (
    <Box flexDirection="column" width={rowWidth} alignItems="center">
      {Picture(ui, $, site, shown, media, own, pic, box)}
      {frames && Scrub(ui, $, site, media, rowWidth, shown)}
      <Box flexDirection="row" justifyContent="space-between" columnGap={2} flexWrap="wrap" width={rowWidth}>
        <Box flexDirection="row" columnGap={2}>
          {frames && <Button key="back" plain dimColor label="« 5s" onPress={() => act('skip_back') || seek($, site, media, one.frame / frames.fps - 5, shown)} />}
          {frames && <Button key="forward" plain dimColor label="5s »" onPress={() => act('skip_forward') || seek($, site, media, one.frame / frames.fps + 5, shown)} />}
        </Box>
        <Box flexDirection="row" columnGap={2}>
          {opener}
          {actions}
        </Box>
      </Box>
    </Box>
  )

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} width={(isWide ? Math.max(box.columns, controlsMin) + SIDE + 3 : Math.max(box.columns, controlsMin, below)) + 4}>
      {TitleBar(ui, $, site, shown, { checks })}
      {!hasReport && prLink && (
        <Box flexDirection="row" gap={2}>
          {prLink}
          {shown.change && <Text dimColor wrap="truncate-end">{shown.change}</Text>}
        </Box>
      )}
      <Box flexDirection="row" gap={3} marginTop={1}>
        {stage}
        {isWide && Report(ui, $, site, shown, prLink, { width: SIDE, height: box.rows + (frames ? 3 : 2) })}
      </Box>
      {!isWide && hasReport && <Box marginTop={1}>{Report(ui, $, site, shown, prLink, { width: below })}</Box>}
    </Box>
  )
}

// Both sides at once: names and scores over each, the change at this moment
// spelled out under them, one scrub row, and the list of changes.
async function SplitView(
  ui: Ui,
  $: EngineInterface,
  site: string,
  shown: Shown,
  columns: number,
  rows: number,
  isPane: boolean,
  prLink: Ui,
) {
  const { Box, Text, Image, Button } = ui
  const one = player(site)
  const before = shown.compare!
  const pair = shown.pair!
  // One merged clip, Original left and Updated right: one picture per frame.
  const box = sizeFor(shown.pairWidth ?? shown.width * 2, shown.pairHeight ?? shown.height, columns - (isPane ? 6 : 10), rows, isPane)
  // Never narrower than the controls, so the tabs and buttons always fit.
  const width = Math.max(box.columns, Math.min(Math.max(CONTROLS_MIN, tabsWidth(shown) + 14), columns - (isPane ? 6 : 10)))
  // The Updated side starts past the Original side and the gap between them.
  const pairPx = shown.pairWidth ?? shown.width * 2
  const half = Math.round((width * ((pairPx - PAIR_GAP) / 2 + PAIR_GAP)) / pairPx)
  const seconds = one.frame / shown.frames!.fps
  const change = changeAt(shown, seconds)
  const { fixed, broken } = checkDiff(shown.checks, before.checks)
  one.box = { columns: box.columns, rows: box.rows }
  await pairReady($, shown, Math.min(one.frame, pair.count - 1), site)
  const pic = await picFor($, frameFile(pair, Math.min(one.frame, pair.count - 1)), box)
  probe($, site, 'view-pair', pic)
  const head = (s: Shown, fallback: string, w: number) => {
    const words = resultWords(s.checks)
    const ok = (s.checks ?? []).every(c => c.ok)
    return (
      <Box width={w} flexDirection="row" gap={1}>
        <Text bold>{s.label ?? fallback}</Text>
        {words && <Text color={ok ? 'success' : 'error'}>· {words}</Text>}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} width={width + 4}>
      {TitleBar(ui, $, site, shown, { width, pr: prLink })}
      {shown.change && <Text dimColor wrap="truncate-end">{shown.change}</Text>}
      <Box flexDirection="column" alignItems="center" width={width}>
        <Box flexDirection="row" marginTop={1} width={box.columns}>
          {head(before, 'Original', half)}
          {head(shown, 'Updated', box.columns - half)}
        </Box>
        {Image ? (
          <Image key="view-pair" source={'file' in pic.src ? { ...pic.src, generation: box.columns * 1000 + box.rows } : pic.src} columns={box.columns} rows={box.rows} alt="[original and updated, side by side]" />
        ) : (
          <Text dimColor>This surface cannot draw images.</Text>
        )}
      </Box>
      <Box width={width}>
        {change ? (
          <Text wrap="truncate-end">
            <Text dimColor>{clock(change.check.at ?? 0)} · </Text>
            {change.check.name}
            <Text dimColor> · </Text>
            <Text color={change.was ? 'success' : 'error'}>{before.label ?? 'Original'} {change.was ? '✓' : '✗'}</Text>
            <Text dimColor> → </Text>
            <Text color={change.check.ok ? 'success' : 'error'}>{shown.label ?? 'Updated'} {change.check.ok ? '✓' : '✗'}</Text>
          </Text>
        ) : (shown.checks?.length || before.checks?.length) ? (
          <Text dimColor>Same so far: both sides match up to {clock(seconds)}</Text>
        ) : null}
      </Box>
      {Scrub(ui, $, site, shown, width, shown)}
      <Box width={width} justifyContent="flex-end">{Actions(ui, $, shown, shown.source ?? shown.path, width < 60)}</Box>
      {(fixed.length > 0 || broken.length > 0) && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>{fixed.length} fixed · {broken.length} broke · click one to jump there</Text>
          {Changes(ui, $, site, shown, fixed, broken)}
        </Box>
      )}
    </Box>
  )
}

// The one line a show call's row reads: what it shows, and what with.
export function toolLine(tool: string, input: unknown, isRunning: boolean): string {
  const i = (input ?? {}) as { path?: string; title?: string; compare?: string; compare_label?: string; checks?: unknown[] }
  const what = i.title ?? i.path?.split('/').pop() ?? ''
  const extra = [
    i.compare ? `vs ${i.compare_label ?? i.compare.split('/').pop()}` : '',
    i.checks?.length ? `${i.checks.length} checks` : '',
  ].filter(Boolean)
  const verb = tool.endsWith('video') ? (isRunning ? 'Cutting video' : 'Video') : isRunning ? 'Loading image' : 'Image'

  return `${tool.endsWith('video') ? '▶' : '▣'} ${verb} · ${what}${extra.length ? ` · ${extra.join(' · ')}` : ''}`
}
