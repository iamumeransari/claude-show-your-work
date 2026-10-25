// Pictures inside tmux. Claude Code draws a picture as kitty Unicode
// placeholders, plain text tmux passes on, plus one command carrying the
// picture, which it sends without tmux's pass-through wrapper, so tmux drops
// it (#15). A forwarder on the pane (pipe-pane) copies each picture command
// back into the pane, wrapped: tmux unwraps it for the terminal around it,
// which then paints the placeholders. Claude Code only draws placeholders in
// tmux when started with FORCE set, and only Ghostty and kitty paint them.
import type { EngineInterface } from 'claude-code'

import { event } from './diagnostics'
import { state } from './state'

export const FORCE = 'CLAUDE_CODE_FORCE_TERMINAL_IMAGES'

// Reads the pane's output. Each kitty graphics command not already wrapped is
// wrapped for pass-through (q=2: the terminal's replies would come back as
// typed keys) and written into the pane once its output has been quiet for
// 30 ms, so it never lands inside one of Claude Code's own sequences.
export const FORWARD_PL = String.raw`use strict; use IO::Select;
open(my $tty, '>', $ARGV[0]) or exit 1;
binmode STDIN; binmode $tty;
my $sel = IO::Select->new(\*STDIN);
my ($buf, $out) = ('', '');
while (1) {
  if ($sel->can_read(length($out) ? 0.03 : undef)) {
    my $n = sysread(STDIN, my $chunk, 1 << 16);
    last unless $n;
    $buf .= $chunk;
    while ((my $i = index($buf, "\e_G")) >= 0) {
      my $j = index($buf, "\e\\", $i + 3);
      if ($j < 0) { $buf = substr($buf, $i); last }
      my $cmd = substr($buf, $i + 3, $j - $i - 3);
      my $wrapped = $i > 0 && substr($buf, $i - 1, 1) eq "\e";
      $buf = substr($buf, $j + 2);
      next if $wrapped;
      my ($keys, $data) = split /;/, $cmd, 2;
      $keys = join ',', (grep { !/^q=/ } split /,/, $keys), 'q=2';
      $out .= "\ePtmux;\e\e_G$keys" . (defined $data ? ";$data" : '') . "\e\e\\\e\\";
    }
    $buf = substr($buf, -2) if index($buf, "\e_G") < 0 && length($buf) > 2;
  } elsif (length $out) { syswrite($tty, $out); $out = '' }
}
`

// What tmux was asked, so session end can undo it.
let forwarding = ''

// The terminal around tmux, from the version it told tmux (`ghostty 1.2.3`,
// `WezTerm 20240203-...`): one of NO_PLACEHOLDERS' keys, or ''.
export const outerOf = (termtype: string) => (/^(warp|wezterm|konsole)\b/i.exec(termtype)?.[1] ?? '').toLowerCase()

// Starts the forwarder on this pane: false where it can't (pictures not
// forced on, a terminal around tmux that can't paint placeholders, another
// pipe-pane already running, an old tmux), and the picture then shows a
// notice. A terminal it can't paint in becomes state.terminalName.
export async function forwardPictures($: EngineInterface): Promise<boolean> {
  const pane = (await $.env.get('TMUX_PANE')) ?? ''
  if (!pane) return false
  const tmux = (args: string[]) => Promise.resolve().then(() => $.process.run(['tmux', ...args])).catch(() => null)
  const facts = await tmux(['display', '-p', '-t', pane, '#{pane_tty}\t#{pane_pipe}\t#{client_termtype}'])
  const [tty, piped, outer] = (facts?.exitCode === 0 ? facts.stdout.trim() : '').split('\t')
  event('tmux', { tty, piped, outer })
  state.outerTerminal = (/^(ghostty|kitty)\b/i.exec(outer ?? '')?.[1] ?? '').toLowerCase()
  if (outerOf(outer ?? '')) {
    state.terminalName = outerOf(outer ?? '')
    return false
  }
  if (!/^(1|true|on|yes)$/i.test((await $.env.get('CLAUDE_CODE_FORCE_TERMINAL_IMAGES')) ?? '')) {
    // Claude Code reads it only at launch: this one needs a restart (the
    // notice copies the command), new tmux panes get it from tmux.
    await tmux(['set-environment', '-g', 'CLAUDE_CODE_FORCE_TERMINAL_IMAGES', '1'])
    return false
  }
  if (!tty?.startsWith('/dev/') || piped === '1') return false
  const script = `${state.TMP}/tmux-forward.pl`
  await $.fs.write(script, FORWARD_PL)
  // This pane only: the person's own tmux settings are left as they are.
  const passthrough = await tmux(['set', '-p', '-t', pane, 'allow-passthrough', 'on'])
  if (passthrough?.exitCode !== 0) return false
  const piping = await tmux(['pipe-pane', '-O', '-t', pane, `exec perl '${script.replace(/'/g, "'\\''")}' '${tty}'`])
  if (piping?.exitCode !== 0) return false
  forwarding = pane
  return true
}

export async function stopForwarding($: EngineInterface) {
  if (!forwarding) return
  const pane = forwarding
  forwarding = ''
  await Promise.resolve().then(() => $.process.run(['tmux', 'pipe-pane', '-t', pane])).catch(() => undefined)
}
