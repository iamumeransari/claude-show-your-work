import { state } from './state';
import { measureCells } from './layout';
export const PICK_TMP = [
    'base="${TMPDIR:-/tmp}"; base="${base%/}"; d="$base/claude-show-your-work-$(id -u)"',
    'mkdir -m 700 -p "$d" 2>/dev/null',
    'if [ -d "$d" ] && [ ! -L "$d" ] && [ -O "$d" ]; then chmod 700 "$d"; printf "%s" "$d"; else mktemp -d "$base/claude-show-your-work-XXXXXX"; fi',
].join('\n');
export const isAtLeast = (version, least) => {
    const [a, b] = [version, least].map(v => v.split(/[.-]/).slice(0, 3).map(Number));
    for (let i = 0; i < 3; i++)
        if ((a[i] ?? 0) !== (b[i] ?? 0))
            return (a[i] ?? 0) > (b[i] ?? 0);
    return true;
};
// Where things are: the temp folder, home, ffmpeg and the cell's size. Run at
// session start, and by anything that needs it before then, since a reload
// mid-session can bring the module back without a session start.
export function setUp($) {
    // Each step on its own: one that fails leaves the defaults, never a throw.
    const tryRun = (argv, options) => Promise.resolve().then(() => $.process.run(argv, options)).catch(() => null);
    return (state.setup ??= (async () => {
        // After a reload the session start doesn't run again: ask the session
        // where it runs, so history is read from the right folder.
        if (!state.cwd)
            state.cwd = (await Promise.resolve().then(() => $.session.cwd()).catch(() => '')) || ((await tryRun(['pwd']))?.stdout ?? '').trim();
        const picked = await tryRun(['sh', '-c', PICK_TMP]);
        if (picked && picked.exitCode === 0 && picked.stdout.trim().startsWith('/'))
            state.TMP = picked.stdout.trim();
        // A login shell finds ffmpeg where the person's profile puts it; one that
        // hangs gets five seconds, then a plain shell and the usual places.
        const where = 'echo "home=$HOME"; echo "ff=$(command -v ffmpeg)"; echo "fp=$(command -v ffprobe)"; echo "os=$(uname -s)"';
        const run = (flag) => tryRun(['sh', flag, where], { timeoutMs: 5000 });
        const login = await run('-lc');
        const env = (login?.stdout.includes('os=') ? login : await run('-c')) ?? { stdout: '', stderr: '', exitCode: 1 };
        const got = (key) => env.stdout.split('\n').find(l => l.startsWith(`${key}=`))?.slice(key.length + 1).trim() ?? '';
        state.home = got('home') || ((await Promise.resolve().then(() => $.env.get('HOME')).catch(() => '')) ?? '');
        state.isMac = got('os') !== 'Linux';
        state.ffmpeg = got('ff') || (state.isMac ? '/opt/homebrew/bin/ffmpeg' : '/usr/bin/ffmpeg');
        state.ffprobe = got('fp') || (state.isMac ? '/opt/homebrew/bin/ffprobe' : '/usr/bin/ffprobe');
        state.hasVideoTools = false;
        // Over ssh the terminal can't read this machine's files: pictures go as bytes.
        const sshConnection = await Promise.resolve().then(() => $.env.get('SSH_CONNECTION')).catch(() => undefined);
        const sshTty = await Promise.resolve().then(() => $.env.get('SSH_TTY')).catch(() => undefined);
        if (sshConnection || sshTty)
            state.sendBytes = true;
        const engine = await Promise.resolve().then(() => $.session.version()).catch(() => null);
        state.canColourButtons = !!engine && isAtLeast(engine.base ?? engine.version, '2.1.295');
        await Promise.resolve().then(() => measureCells($)).catch(() => undefined);
    })());
}
