# Video

Kitty-protocol terminals show still pictures only, so a video plays as PNG frames swapped with `$.ui.blit`.

## Frames

- Sampled at up to 12 frames a second (`sampleRate`). A clip of known length has at most `MAX_STREAMED` (3600) frames, so up to five minutes plays at the full rate; only a few chunks are on disk at once, so a longer clip costs no more disk or memory. A clip with no duration is cut whole and stays at `MAX_FRAMES` (900). (A 24 fps option was tried and dropped: smoother, but it doubled the cutting work.)
- Cut at the width the player really shows (`frameWidth`), so the picture fills its box (the terminal never enlarges it).
- A clip of known length is cut as it plays, `CHUNK` (24 frames, 2 s) at a time. Around the chunk on screen, 5 s behind and 5 s ahead stay on disk (`chunksBehind`, `chunksAhead`: 3 chunks each); the rest are pruned. The ones ahead are cut in advance, one ffmpeg process at a time (`cutAhead`, `CUT_WORKERS`), each with ffmpeg's default threads and at normal priority. Until 0.7.0 cuts ran on one thread, two at once, with chunks two or more ahead at macOS's utility class (`taskpolicy -c utility`). That held up on a plain test clip, but real footage (a 72 Mbit/s 1080p H.264 export with keyframes up to 3 s apart) cut at 4.9 s per 2 s chunk on one thread, and with every core busy macOS starved the utility-class cut entirely: playback reached that chunk, waited on it and froze (#14). Default threads cut the same chunk in 1.4 s (2.4 s with every core busy) at about 310 MB peak instead of 133 MB. A process can't raise itself above normal priority without root (`nice -n -5` is refused, `taskpolicy` only lowers). Before a video is shown, its first 5 s are cut too (`prefill`), waiting at most 4 s. Keeping only one chunk behind and one ahead made every skip cut its chunk first, a visible freeze. Frame 1 (the poster) always stays. A longer seek or a scroll back cuts the chunk again.
- **H.264 and HEVC decode on the media engine** on macOS (`-hwaccel videotoolbox`, `decodeFlags`): frames identical to software (PSNR inf), 0.37x against 0.28x real time for a 60 Mbit/s 1080p clip beside a render. Only those codecs: on an M1, AV1 fails outright with it (exit 69, no frames) instead of falling back; ProRes, VP8, VP9 and GIF fall back by themselves. A cut that fails with it runs again without it (`cutFrames`).
- A clip with no duration (some MediaRecorder webm) is cut whole.
- A white lead-in at the start of a recording is skipped (`whiteLead`).
- Each clip gets a folder `v-<key>` where the key covers the file, its size and time, and the cut width, so a wider window cuts the clip again, wider.
- The size label shows the clip's own size (from ffprobe), not the frames' size.

## 256 colours

Frames are a preview copy, so they are cut with a 256-colour palette (`PALETTE`): one palette per chunk, no dithering. Measured on the tour videos at 1600 px:

| | per frame | per 2 s chunk |
|---|---|---|
| full colour, `-compression_level 1` | 346 to 385 KB | 0.2 to 0.33 s |
| 256 colours, one palette per chunk | 140 to 163 KB | 0.46 to 0.48 s |

- No visible difference on photos, text or soft shadows. A very smooth gradient could band; the original is untouched and View opens it.
- A palette per frame (`stats_mode=single`) is no smaller and ~3x slower. Dithering (`sierra2_4a`, `bayer`) costs time and makes PNGs bigger.
- Lossless tuning (`-pred mixed`, higher compression levels) gains almost nothing for much more time.
- **`palettegen` waits for the end of its input.** Every ffmpeg call that cuts frames must limit the input with `-t` (`chunkSeconds`), not only the output with `-frames:v`. Without `-t` the palette step reads the whole video, and each 2 s chunk took ~3 s.

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

`SHOW_YOUR_WORK_DEBUG=1` writes playback timings to `debug.log` in the temp folder, flushed once a second: `play` (fps, frame count), `tick gap=` (ms since the last tick; 83 at 12 fps), `wait` (next frame not cut yet), `cut chunk= ms=`, `blit frame= ms=`, `drop` (a frame skipped while a swap was in flight), `stale` and `redraw`. Measured on an M1: a 2 s chunk cuts in 0.2–0.4 s and a frame reads in ~1 ms, so lag is the timer firing late or the swaps, not decoding.

Playback keeps real time (`play`): each tick owes the frames its real elapsed time is worth (one at least; `clock.every` asks for the next period only once a tick has run, so ticks come late, 85 ms and up for 83, and counting ticks alone played at about 0.9×), and when the frames ahead aren't cut yet the picture holds, then jumps to the furthest cut frame toward where the clock is, instead of waiting on every frame (slow motion, #14). Before the first frame moves the clock never runs ahead, so pressing play never skips the start. Measured on a 33 s clip of 72 Mbit/s 1080p footage with 16 busy processes on 8 cores: 95 frames then frozen before 0.7.0, 1.00× real time throughout after (idle too).

## Sound

A video with a sound stream gets Unmute beside the skip buttons. Sound is off at every session start and stays off for videos that start by themselves (Claude's calls, the tour) until the person presses Play or Unmute on them. Nothing plays over ssh, from a background session (`CLAUDE_CODE_SESSION_KIND=bg`), without `ffplay`, or in the side-by-side view.

- **The sound is the clock.** `ffplay -stats` prints its position (`  3.96 M-A: …`) about every 35 ms; each tick shows the frame for that moment (`soundNow`, `soundStep` in `play`). The picture can't drift from the sound: measured within one frame (83 ms) over a 20 s clip, and it followed a sound device running at 0.97x.
- **Start-up:** `ffplay` takes ~0.5 s to open the audio device. The picture holds on its frame until the first position arrives, so sound and picture start together.
- **The output device's delay:** `ffplay`'s position allows for its own buffer, not for the device after it: measured 160 ms for AirPods Pro, a few ms for built-in speakers. Without it the picture ran that far ahead of what's heard. `measureLatency` reads it on macOS with `osascript -l JavaScript` from `AVAudioEngine`'s `outputNode.presentationLatency` (output side only, so no microphone prompt; ~0.4 s, 3 s the first time), on Unmute and at every start, since the device can change mid-session; `soundNow` subtracts it (`heardAt`), so the picture holds at each start until the sound is heard. CoreAudio's `AudioObjectGetPropertyData` can't be called from JXA (it won't pass raw pointers). Linux: not read, taken as 0.
- **Frames behind:** when the frame for the sound's moment isn't cut, the sound stops and the picture holds until 2 s ahead are cut, then both start again from the frame on screen. After the fourth start in one play (`SOUND_RESTARTS`), or a hold over 6 s, the sound is given up (`sound_gave_up`) and the clip plays on silently by real time. Measured with a 60 Mbit/s 1080p clip: no stops with 10 busy processes on 8 cores; with 30, three restarts then silent.
- **Never outlives the picture:** every pause path goes through `halt`; the reading loop ends `ffplay` once the play timer has been quiet for 1 s (`sound_orphaned`); `session.end` stops all of it; the engine kills spawned children when the module unloads; and the file ends where the clip does.
- **Nobody watching:** a session leaves its window two ways, and neither leaves sound playing. `/background` ends the window's process and resumes the conversation in a new background one: `session.end` stops `ffplay` (measured: gone within 3.5 s, nothing restarted). A session opened with `claude attach` is a background one already, so it shows the background notice and has no player. Don't stop sound on `session.detach`: it fires for remote clients (a phone) leaving, while the terminal may still be listening.
- **The file:** cut on Unmute (or on the first play with sound on), once per clip: from the frames' lead-in, as long as the frames run, mono 16-bit 22.05 kHz WAV (~2.6 MB a minute), padded with `aresample=first_pts=0` so its time 0 is frame 0. Cut to `.part`, then moved, so a cut that dies never leaves a short file. Named `sound-<key>.wav` in the temp folder by the source's identity; the week-old cleanup removes it.
- **Frames and sound file line up:** `tools/sound-align.py` makes clips that flash and beep together (picture or sound stream starting late, 25 and 29.97 fps, a blank opening, two minutes) and runs them through the plugin's cut commands. All 12 within the frame rate's quantisation (−51 to +47 ms at 12 fps), no drift over two minutes, also with a blank-opening skip forced on (`LEAD=1`; the skip is off in the plugin). ffmpeg keeps each stream's own start offset through `-ss`, so a late-starting stream needs no correction. Read clip timings with `-copyts` (the true pts) before trusting a generated test clip: `-itsoffset` plus a `-vf` that uses `t` shifts the picture's events by the offset too.
- **Memory:** one `ffplay` at a time, only while sound plays.
