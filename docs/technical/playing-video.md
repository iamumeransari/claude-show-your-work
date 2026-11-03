# Video

Kitty-protocol terminals show still pictures only, so a video plays as frames swapped with `$.ui.blit`: raw RGB files where the terminal reads the plugin's files itself, PNGs where it can't (see Raw frames).

## Frames

- Sampled at up to 12 frames a second (`sampleRate`). A clip of known length has at most `MAX_STREAMED` (3600) frames, so up to five minutes plays at the full rate; only a few seconds are on disk at once, so a longer clip costs no more disk or memory. A clip with no duration is cut whole and stays at `MAX_FRAMES` (900). (A 24 fps option was tried and dropped: smoother, but it doubled the cutting work.)
- Cut at the width the player really shows (`frameWidth`), so the picture fills its box (the terminal never enlarges it).
- A clip of known length is decoded as it plays, by one ffmpeg per frames folder (`decode`, `ensure`) that runs straight through from where it's needed and reports each frame with `-progress pipe:1` (each report checked with one `stat` of the newest file: frames land in order). Before 0.8.1 it was cut `CHUNK` (24 frames, 2 s) at a time, a new process per chunk that decoded again from the keyframe before it; over 12 s of a 60 Mbit/s 1080p clip with keyframes 3 s apart, six chunk cuts took 6.8 s and 6.1 s of CPU, one continuous decode 2.8 s and 3.4 s (2.4 s and 2.7 s scaled on the media engine).
  - **Playing:** the decoder reads at the clip's own pace (`-readrate 1`), with a head start and `-readrate_catchup 4` for the stretch from the keyframe before its first frame (without catch-up the first frame took 1.8 s instead of 0.7 s, and the decoder ran behind from there). The head start (`AHEAD_SECONDS + START_SECONDS - buffered`) settles it about `AHEAD_SECONDS` (3 s) ahead of the playhead, so 3s » lands on frames already there. A busy machine decodes slower than real time; the decoder then runs flat out. It is started as soon as Play is pressed: its first frame takes 0.7 to 1.5 s (ffmpeg start-up plus the keyframe stretch, `START_SECONDS`), so it has to start while the frames on disk last.
  - **Shown, not playing:** a clip shown (or paused and moved) decodes `AHEAD_SECONDS` from where it is, then its decoder ends. It has to be more than `START_SECONDS`: with 1 s, every Play froze ~0.6 s at the hand-over to the playing decoder.
  - **Stopping:** a playing decoder ends once no frame has been asked for in `PLAY_IDLE_MS` (1 s) and no one waits on its frames (a player waiting on a frame asks nothing meanwhile: counting that as idle killed the decoder it waited for). Another clip used stops it at once (`use`). Nothing is ever paused with SIGSTOP: a stopped ffmpeg could outlive Claude Code holding its memory.
  - **Jumps:** a frame asked for more than a second past where the decoder has got starts a new one there. The play clock asking ahead of a slow decoder (`isChase`) does so only after the decoder has run `CHASE_MS` (2 s): restarting on every tick meant it never got going.
  - Each decoder uses ffmpeg's default threads at normal priority. Until 0.7.0 cuts ran on one thread, with chunks two or more ahead at macOS's utility class (`taskpolicy -c utility`); with every core busy macOS starved the utility class entirely and playback froze (#14). A process can't raise itself above normal priority without root.
  - ffmpeg before 7.1 has no `-readrate_catchup` (6.1 no `-readrate_initial_burst`): there, a playing clip is decoded a few seconds at a time (`canPace`).
- **H.264 and HEVC decode on the media engine** on macOS (`-hwaccel videotoolbox`, `decodeFlags`): frames identical to software (PSNR inf), 0.37x against 0.28x real time for a 60 Mbit/s 1080p clip beside a render. Only those codecs: on an M1, AV1 fails outright with it (exit 69, no frames) instead of falling back; ProRes, VP8, VP9 and GIF fall back by themselves. A decoder that fails with it runs again without it. Raw frames are scaled on the media engine too (`scale_vt`, `gpuScale`; 10-bit HEVC comes down as `p010le`): 23% less CPU. Leaving frames unscaled was no cheaper (converting the bigger frame to RGB costs more).
- A clip with no duration (some MediaRecorder webm) is cut whole.
- A white lead-in at the start of a recording is skipped (`whiteLead`).
- Each clip gets a folder `v-<key>` where the key covers the file, its size and time, and the cut width, so a wider window cuts the clip again, wider.
- The size label shows the clip's own size (from ffprobe), not the frames' size.

## 256 colours

Over ssh frames are cut with a 256-colour palette (`PALETTE`), no dithering. Measured on the tour videos at 1600 px:

| | per frame | per 2 s chunk |
|---|---|---|
| full colour, `-compression_level 1` | 346 to 385 KB | 0.2 to 0.33 s |
| 256 colours, one palette per chunk | 140 to 163 KB | 0.46 to 0.48 s |

- No visible difference on photos, text or soft shadows. A very smooth gradient could band; the original is untouched and View opens it.
- Since 0.8.1 it is a palette per frame (`palettegen=stats_mode=single`, `paletteuse=new=1`): `palettegen` otherwise waits for the end of its input, which a decoder running to the end of the clip never reaches. It is no smaller than one per chunk and was ~3x slower per frame in a chunk; over ssh the bytes, not the cutting, are the limit. Dithering (`sierra2_4a`, `bayer`) costs time and makes PNGs bigger.
- Lossless tuning (`-pred mixed`, higher compression levels) gains almost nothing for much more time.

## Playback

- A video Claude shows plays once by itself (`freshCalls`), not ones a reload redraws.
- Scrolling a player out of view stops it; scrolling back sends the frame on screen again.
- Clicking a change pauses the video at that moment.
- Compare plays the original and updated recordings side by side, in sync: times are mapped through the checks both sides share (`anchors`, `mapTime`).
- Over ssh every frame crosses as bytes; expect it to be slower than local.
- **One swap at a time per picture** (`blit`, `swaps`). A swap still in flight holds only the newest frame asked for; frames in between are dropped. Each draw takes a ticket, and a draw whose frame was ready after a newer draw's is skipped. Before this, every tick fired its own swap: on a busy machine they queued (playback fell further behind) and landed out of order (frames jumped back and forth).
- The draw check (`probe`, once per session, 250 ms after the first draw) re-sends the frame on screen, not the poster: sending the poster jumped a playing clip back to its start for a moment.
- The play timer never runs ahead of the frames: a tick whose next frame is still being cut waits for it.

## Timing log

`SHOW_YOUR_WORK_DEBUG=1` writes playback timings to `debug.log` in the temp folder, flushed once a second: `play` (fps, frame count), `tick gap=` (ms since the last tick; 83 at 12 fps), `wait` (next frame not decoded yet), `decode from= to= play=` and `decode first= ms=`, `blit frame= ms=`, `drop` (a frame skipped while a swap was in flight), `stale` and `redraw`. A frame reads in ~1 ms.

Playback keeps real time (`play`): each tick owes the frames its real elapsed time is worth (one at least; `clock.every` asks for the next period only once a tick has run, so ticks come late, 85 ms and up for 83, and counting ticks alone played at about 0.9×), and when the frames ahead aren't cut yet the picture holds, then jumps to the furthest cut frame toward where the clock is, instead of waiting on every frame (slow motion, #14). Before the first frame moves the clock never runs ahead, so pressing play never skips the start. Measured on a 33 s clip of 72 Mbit/s 1080p footage with 16 busy processes on 8 cores: 95 frames then frozen before 0.7.0, 1.00× real time throughout after (idle too).

## Raw frames

Since 0.8.1 a video's frames are raw RGB files (`f00001.rgb`, `usesRaw`), drawn with `{ file, format: 'rgb', width, height }`: ffmpeg writes them without compressing and the terminal draws them without decoding. PNG stays only where raw can't go: pictures sent as bytes (ssh: 4.7 MB a frame through the connection) and terminals that read only small files (Orca, `readsAnyFile`).

- **Why:** for 1080p camera footage a PNG costs ~0.2 s of CPU a frame (zlib at level 1; the filter step is cheap) and is only 30% smaller than raw. Measured over 12 s of a 60 Mbit/s clip with 24 busy processes: PNG 0.43–0.48x real time and 31 s of CPU, raw 0.83–0.91x and 7.5 s (0.90–0.93x and 6.1 s resized on the media engine). No zlib setting is cheaper short of level 0, which is raw's size. Claude Code takes PNG or raw only, not zlib-compressed raw.
- **Size:** width x height x 3 bytes, the height read back from the first frame's size on disk (`rawSize`; ffmpeg's `-2` keeps the aspect after any rotation), every later decoder at that exact size. 4.7 MB at 1670 px, 1.4 MB at ~900 px.
- **What stays on disk:** the clip in use (the one last played, paused, scrubbed or newly shown, `use`) keeps 3 s behind its playhead (`BEHIND_SECONDS`), so « 3s and a scrub back are instant: those frames were decoded on the way past and cost only disk. Ahead it keeps 3 s, or as far as its decoder has got (`isKept`). At 1846 px: about 500 MB while the heavy clip plays (pruning runs once a second), 210 MB paused. Every other clip keeps only the frame it shows, every clip its poster. A folder no player has drawn yet keeps what's made (a clip being prepared). Pruning lists the folder at most once a second per folder (`prune`). The skip buttons move 3 s (`SKIP_SECONDS`) and land on frames there: 6 to 18 ms measured, playing or paused. A scrub to a place never decoded takes a decoder's start (1.2 s measured).
- **Atomic writes:** raw frames are written with `-atomic_writing 1` (a side name, then renamed): the terminal never reads half a frame.
- **Side by side:** each side is decoded by its own decoder, and the merged frames (Original left, Updated right) are made from them a second at a time by one ffmpeg (`merge`). The merged frames stay PNGs: two clips, rarely played, and a PNG carries its own size, so there's nothing to get wrong.
- **Measured** (heavy clip above, quiet machine, 1846 px): 291 of 300 frames shown, longest gap 115 ms; with sound 300 of 302 samples within a frame of the sound. Raw frames cut in chunks (never released), one fair run under 24 busy processes: 255 frames, freezes up to 1 s; 0.8.0 (PNG chunks) 80 frames, freezes up to 5.5 s.

## Sound

A video with a sound stream gets Mute (or Unmute) beside the skip buttons. Sound is on at every session start, and Mute holds for the rest of the session. A video Claude shows plays with sound from the start; tour videos stay quiet until the person presses Play or Unmute on them. Nothing plays over ssh, from a background session (`CLAUDE_CODE_SESSION_KIND=bg`), without `ffplay`, or in the side-by-side view.

- **The sound is the clock.** `ffplay -stats` prints its position (`  3.96 M-A: …`) about every 35 ms; each tick shows the frame for that moment (`soundNow`, `soundStep` in `play`). The picture can't drift from the sound: measured within one frame (83 ms) over a 20 s clip, and it followed a sound device running at 0.97x.
- **Start-up:** `ffplay` takes ~0.5 s to open the audio device. The picture holds on its frame until the first position arrives, so sound and picture start together.
- **The output device's delay:** `ffplay`'s position allows for its own buffer, not for the device after it: measured 160 ms for AirPods Pro, a few ms for built-in speakers. Without it the picture ran that far ahead of what's heard. `measureLatency` reads it on macOS with `osascript -l JavaScript` from `AVAudioEngine`'s `outputNode.presentationLatency` (output side only, so no microphone prompt; ~0.4 s, 3 s the first time), on Unmute and at every start, since the device can change mid-session; `soundNow` subtracts it (`heardAt`), so the picture holds at each start until the sound is heard. CoreAudio's `AudioObjectGetPropertyData` can't be called from JXA (it won't pass raw pointers). Linux: not read, taken as 0.
- **Frames behind:** when the frame for the sound's moment isn't cut, the sound stops and the picture holds until 2 s ahead are cut, then both start again from the frame on screen. After the fourth start in one play (`SOUND_RESTARTS`), or a hold over 6 s, the sound is given up (`sound_gave_up`) and the clip plays on silently by real time. Measured with a 60 Mbit/s 1080p clip: no stops with 10 busy processes on 8 cores; with 30, three restarts then silent.
- **Never outlives the picture:** every pause path goes through `halt`; the reading loop ends `ffplay` once the play timer has been quiet for 1 s (`sound_orphaned`); `session.end` stops all of it; the engine kills spawned children when the module unloads; and the file ends where the clip does.
- **Nobody watching:** a session leaves its window two ways, and neither leaves sound playing. `/background` ends the window's process and resumes the conversation in a new background one: `session.end` stops `ffplay` (measured: gone within 3.5 s, nothing restarted). A session opened with `claude attach` is a background one already, so it shows the background notice and has no player. Don't stop sound on `session.detach`: it fires for remote clients (a phone) leaving, while the terminal may still be listening.
- **The file:** cut on the first play with sound on (or on Unmute), once per clip: from the frames' lead-in, as long as the frames run, mono 16-bit 22.05 kHz WAV (~2.6 MB a minute), padded with `aresample=first_pts=0` so its time 0 is frame 0. Cut to `.part`, then moved, so a cut that dies never leaves a short file. Named `sound-<key>.wav` in the temp folder by the source's identity; the week-old cleanup removes it.
- **Frames and sound file line up:** `tools/sound-align.py` makes clips that flash and beep together (picture or sound stream starting late, 25 and 29.97 fps, a blank opening, two minutes) and runs them through the plugin's cut commands. All 12 within the frame rate's quantisation (−51 to +47 ms at 12 fps), no drift over two minutes, also with a blank-opening skip forced on (`LEAD=1`; the skip is off in the plugin). ffmpeg keeps each stream's own start offset through `-ss`, so a late-starting stream needs no correction. Read clip timings with `-copyts` (the true pts) before trusting a generated test clip: `-itsoffset` plus a `-vf` that uses `t` shifts the picture's events by the offset too.
- **Memory:** one `ffplay` at a time, only while sound plays.
