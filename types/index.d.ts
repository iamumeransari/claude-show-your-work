export type Frames = { dir: string; count: number; fps: number; duration: number; lead?: number; cut?: number; audio?: string }

// One QA check: its name, whether it passed, and when it happens in a clip.
export type Check = { name: string; ok: boolean; at?: number; url?: string }

// One change to review: what changed, optionally when it shows in the clip and
// the page it is on.
export type KeyChange = { title: string; detail?: string; at?: number; url?: string }

// One line of the QA summary: a group of checks, whether it passed, and how
// many of its checks did.
export type Summary = { label: string; ok: boolean; passed?: number; total?: number }

// A play button over the centre of a paused video, or none. (A grid of
// buttons over the whole picture was tried: it erases the picture.)
export type Overlay = 'center' | 'none'

export type Shown = {
  kind?: 'image' | 'video'
  // the PNG the terminal draws (a video's first frame)
  path: string
  // the file the user gave, for Open and Reveal
  source?: string
  /** The file as the user knows it (source is the kept copy). */
  origin?: string
  // the picture drawn (a video's frames), in pixels
  width: number
  height: number
  /** The file's own size, for its label, when the picture drawn is another size. */
  sourceWidth?: number
  sourceHeight?: number
  title: string
  generation: number
  frames?: Frames
  // QA context: the change, its PR, the checks run
  change?: string
  pr?: string
  // the page the recording or picture is of, to open it there
  url?: string
  checks?: Check[]
  // what to review, and the QA in three lines
  changes?: KeyChange[]
  summary?: Summary[]
  // the other side of a before/after, and the two sides' names
  compare?: Shown
  /** Earlier kept versions of the same file, oldest first; compare is the last. */
  history?: { path: string; note?: string }[]
  /** The heading over the changes list, when they aren't changes. */
  changesTitle?: string
  /** One line on this version, for the history list. */
  note?: string
  /** Which of history the compared side starts on. */
  historyAt?: number
  // Original and Updated merged into one clip, side by side, and its size
  pair?: Frames
  pairWidth?: number
  pairHeight?: number
  // moments that line up, [updated, original] seconds, matched by how the frames look
  sync?: [number, number][]
  label?: string
  overlay?: Overlay
}

declare module 'claude-code' {
  interface PluginState {
    'show-your-work': { current: Shown | null; welcome: number }
  }
}
