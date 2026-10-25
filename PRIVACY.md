# Privacy

show-your-work runs on your computer. The pictures and videos Claude shows you, your files and your conversations stay on your machine.

## What it sends

It sends two things, and nothing else.

**A version check.** At most once a day, it reads the plugin's latest version number from this repository on `raw.githubusercontent.com`, so it can keep itself up to date. It's an ordinary web request and carries nothing about you.

**Anonymous usage counts**, only while Usage data is set to share in `/show-your-work`. They go to PostHog (`us.i.posthog.com`) and hold:

- the names and counts of things that happened, such as a picture being shown or a button being pressed;
- the plugin and Claude Code versions, the terminal, the operating system, and whether ffmpeg is installed;
- a random install id, made on your computer, that isn't linked to you.

They never include file names, paths, web addresses, titles, prompts, anything from your conversation or anything you type. The plugin tells PostHog not to record your IP address and not to look up your location.

## Turning it off

- Usage data: run `/show-your-work` and choose Don't share. When you turn it off, the plugin sends one last count saying so, then sends nothing more.
- You can also turn usage counts off with `SHOW_YOUR_WORK_TELEMETRY=0`, `DO_NOT_TRACK=1` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.
- Updates: `SHOW_YOUR_WORK_AUTO_UPDATE=0` stops the version check.

## What it keeps on your computer

- Video frames and converted pictures, in a temp folder. Anything older than a week is deleted.
- A copy of each file Claude shows you, in `.show-your-work/` in your project, for version history. Delete the folder any time.
- Your settings and the random install id, in Claude Code's storage for the plugin.
- Only if you start Claude Code with `SHOW_YOUR_WORK_DEBUG=1`: a debug log (`debug.log` in the temp folder) of what the plugin did, including file paths and window sizes, for bug reports. It stays on your computer unless you attach it to an issue yourself.

Apart from the random install id, which goes with the usage counts, nothing kept on your computer is sent anywhere.

## Your data

The install id is random and never linked to your name, email or account, so the usage counts can't be traced back to you.

## Questions

Open an issue at [github.com/iamumeransari/claude-show-your-work/issues](https://github.com/iamumeransari/claude-show-your-work/issues).
