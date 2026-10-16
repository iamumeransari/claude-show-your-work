# Updates, settings and onboarding

## Channels and the updater

- Two channels, two branches: **Stable** follows `releases`, **Latest** follows `latest` (`BRANCHES`). Stable is the default. `main` is development only. Versions before 0.6.0 checked `main`.
- Once a day (`updateCheckedAt`), the updater fetches `.claude-plugin/plugin.json` from the channel's branch. If the version is newer it runs `claude plugin marketplace update` and `claude plugin update`; the new version loads in the next session. Failures say nothing to the user.
- An install pinned to a tag stays on it. A branch that doesn't exist on GitHub yet: stay where it is.
- **Switching channel** moves the marketplace to `url#branch` and reinstalls (`MOVE_SH`). It runs detached (`DETACH`), so quitting Claude Code halfway can't leave the plugin uninstalled. If the new branch fails, the old source goes back, retried twice.
- **Every check is reported** as `update_check` with how it ended: `current`, `update`, `pending`, `folder` (loaded from a folder, not installed), `pinned`, `offline` or `no_cli`. Added in 0.7.0 after PostHog showed many active installs stuck on old versions (0.5.14, 0.5.16, 0.6.1, 0.6.3) with no `update_failed` events: the checks were failing before they could report anything.
- **Claude Code's CLI is found through the login shell** first (`state.claudePath`, the same way as ffmpeg), then the usual locations (`CLAUDE_BINARIES`, including `~/.npm-global/bin` and `/usr/bin`). Hooks run with a thin `PATH`, so a bare `claude` often isn't found.
- **A check that couldn't run (`offline`, `no_cli`) doesn't count for the day,** so the next session tries again instead of waiting 24 hours.
- Off with `SHOW_YOUR_WORK_AUTO_UPDATE=0` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. Update choices saved by earlier versions (`consent` in 0.5.12, `updatesOff` in 0.5.16) are no longer read; their usage data choice (`statsOff`, `consent.stats`) carries over (`earlierNo`).

## Settings

- `/show-your-work` opens the settings pane: update channel, usage data and picture size (`SETTINGS` in `state.ts`). Choices are plain ● / ○ rows, never On/Off.
- Saved in the plugin store under `settings`.
- **`ensureSettings` reads the saved settings once per plugin load,** from the `ToolResult` and `/img` render paths as well as session start. `/reload-plugins` resets module state and may not re-run `session.start`, so before this a reload drew every picture as Standard until the next restart.
- Changing a setting records it on the anonymous PostHog profile (`update_channel`, `picture_size`); a picture size change also redraws players on screen.
- `/show-your-work tour` starts the tour. There is no other settings command (0.5.16's `/show-your-work-settings` was dropped in 0.6.0).

## Welcome and tour

- **Every install sees the welcome and tour once**, updates included, since installs from before 0.6.2 never had one. Shown means `toured` is stored. 0.6.0–0.6.1 stored `welcomed` both when they showed the welcome (fresh install) and when they skipped it (update). An install with `welcomed` but no `toured` is shown it only if a version folder from before 0.6.0 is still in the plugin cache next to this one (`hadVersionBefore06`); otherwise it already saw it and `toured` is stored quietly. Claude Code deletes orphaned version folders after some days, so an update whose old folders are gone is taken for a 0.6 install and misses the tour rather than seeing it twice. Only a fresh install holds updates and usage counts until the welcome; an update (`welcomed`, `installId` or `updateCheckedAt` stored) starts them straight away.
- The tour has five stops (`STOPS`), each pointing at one real control; a stop is done when the person uses it. The last stop shows the settings.
- **While a stop's demo is still loading, only "Loading the demo…" shows,** with no bar, so Next can't be pressed before there's anything to look at.
- **A video whose frames were cleaned from the temp folder is cut again** (`recutFrame`) instead of showing "This preview has expired". Expired now means the original file itself is gone.
- Tour media in `assets/` is 16:10, 1600x1000 (the trip-form recording 2400x1500). Change timings in `prepareTour` if a recording changes.

## Releasing

- `main` is where work lands; `latest` is what testers on Latest get; `releases` is Stable, and the one the Anthropic plugin directory follows. All three are protected against force-pushes and deletion.
- A release bumps `.claude-plugin/plugin.json`, commits as `x.y.z: summary`, and is tagged with `claude plugin tag .` (move an untracked `AGENTS.md` aside first; it must never be committed).
- New versions go to `main` and `latest` first. `releases` moves only after the reporter confirms the fix or the release has soaked. Keep a fix's issue open until then.
- Release and commit text is short and neutral.
