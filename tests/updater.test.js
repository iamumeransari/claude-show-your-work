import { expect, test } from 'claude-code/testing';
import { BRANCHES, MOVE_SH, checkForUpdate } from '../hooks/updater';
// A stand-in for the engine: GitHub says `latest`, the CLI reports `installed`
// from a marketplace of `source`, and every command run is recorded.
function engine(o = {}) {
    const runs = [];
    const fetched = [];
    let installed = o.installed ?? '0.5.0';
    let installFails = o.installFails ?? (o.installFailsOnce ? 1 : 0);
    const toasts = [];
    const store = new Map(o.checkedAt ? [['updateCheckedAt', o.checkedAt]] : []);
    const $ = {
        env: { get: async (name) => o.env?.[name] },
        clock: { now: async () => 10 * 24 * 60 * 60 * 1000 },
        store: { get: async (k) => store.get(k), set: async (k, v) => void store.set(k, v) },
        http: { fetch: async (url) => {
                fetched.push(url);
                return { ok: true, status: 200, headers: {}, text: JSON.stringify({ version: o.latest ?? '0.6.0' }) };
            } },
        ui: { toast: (t) => void toasts.push(t) },
        process: {
            run: async (argv) => {
                if (o.missingBinaries?.includes(argv[0]))
                    throw new Error('ENOENT');
                runs.push(argv);
                const args = argv.slice(1).join(' ');
                if (args === 'plugin marketplace list --json')
                    return { exitCode: 0, stderr: '', stdout: JSON.stringify([{ name: 'iamumeransari', source: o.source ?? 'git', url: 'https://github.com/iamumeransari/claude-show-your-work.git', ref: o.ref === null ? undefined : o.ref ?? 'releases' }]) };
                if (args === 'plugin list --json')
                    return { exitCode: 0, stderr: '', stdout: JSON.stringify([{ id: 'show-your-work@iamumeransari', scope: 'user', version: installed }]) };
                if (args.startsWith('plugin update'))
                    return { exitCode: o.updateExit ?? 0, stderr: '', stdout: '' };
                if (args.startsWith('plugin marketplace add') && args.includes('#'))
                    return { exitCode: o.addExit ?? 0, stderr: '', stdout: '' };
                if (args.startsWith('plugin install') && installFails > 0) {
                    installFails -= 1;
                    return { exitCode: 1, stderr: '', stdout: '' };
                }
                if (args.startsWith('plugin install'))
                    installed = o.latest ?? '0.6.0';
                return { exitCode: 0, stderr: '', stdout: '' };
            },
        },
    };
    return { $: $, runs, toasts, store, fetched };
}
const args = (runs) => runs.map(r => r.slice(1).join(' '));
test('a newer version on GitHub gets installed quietly, for the next session', async () => {
    const e = engine();
    await checkForUpdate(e.$, '0.5.0');
    expect(args(e.runs)).toEqual([
        'plugin marketplace list --json',
        'plugin list --json',
        'plugin marketplace update iamumeransari',
        'plugin update show-your-work@iamumeransari --scope user',
    ]);
    expect(e.toasts.length).toBe(0);
});
test('nothing is installed when GitHub has the same version', async () => {
    const e = engine({ latest: '0.5.0' });
    await checkForUpdate(e.$, '0.5.0');
    expect(args(e.runs)).toEqual(['plugin marketplace list --json']);
});
test('it checks at most once a day', async () => {
    const e = engine({ checkedAt: 10 * 24 * 60 * 60 * 1000 - 60000 });
    await checkForUpdate(e.$, '0.5.0');
    expect(e.runs.length).toBe(0);
});
test('SHOW_YOUR_WORK_AUTO_UPDATE=0 turns it off', async () => {
    const e = engine({ env: { SHOW_YOUR_WORK_AUTO_UPDATE: '0' } });
    await checkForUpdate(e.$, '0.5.0');
    expect(e.runs.length).toBe(0);
});
test('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC turns it off', async () => {
    const e = engine({ env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } });
    await checkForUpdate(e.$, '0.5.0');
    expect(e.runs.length).toBe(0);
});
test('an install pinned to a release tag stays on it', async () => {
    const e = engine({ source: 'git', ref: 'v0.5.15' });
    await checkForUpdate(e.$, '0.5.0');
    expect(args(e.runs)).toEqual(['plugin marketplace list --json']);
});
test('Stable releases read the releases branch, Latest the latest branch', async () => {
    const stable = engine();
    await checkForUpdate(stable.$, '0.5.0');
    expect(stable.fetched[0].includes('/releases/.claude-plugin/plugin.json')).toBe(true);
    const latest = engine({ ref: 'latest' });
    await checkForUpdate(latest.$, '0.5.0', BRANCHES.latest);
    expect(latest.fetched[0].includes('/latest/.claude-plugin/plugin.json')).toBe(true);
    expect(args(latest.runs)).toContain('plugin update show-your-work@iamumeransari --scope user');
});
for (const ref of ['main', null]) {
    test(`an install on ${ref ?? 'no branch'} moves to the releases branch, in a process of its own`, async () => {
        const e = engine({ ref });
        await checkForUpdate(e.$, '0.5.0');
        const launch = e.runs.at(-1);
        // Detached, so quitting Claude Code mid-move can't stop it halfway.
        expect(launch.slice(0, 3)).toEqual(['perl', '-MPOSIX', '-e']);
        expect(launch.slice(4, 6)).toEqual(['sh', '-c']);
        expect(launch[6]).toBe(MOVE_SH);
        expect(launch.slice(8)).toEqual([
            'claude', 'https://github.com/iamumeransari/claude-show-your-work.git', 'releases',
            ref ? 'https://github.com/iamumeransari/claude-show-your-work.git#main' : 'https://github.com/iamumeransari/claude-show-your-work.git',
            'user', 'iamumeransari', 'show-your-work@iamumeransari',
        ]);
        expect(e.toasts.length).toBe(0);
    });
}
test('switching to Latest moves a releases install to the latest branch', async () => {
    const e = engine({ ref: 'releases' });
    await checkForUpdate(e.$, '0.5.0', BRANCHES.latest);
    const launch = e.runs.at(-1);
    expect(launch[10]).toBe('latest');
    expect(launch[11]).toBe('https://github.com/iamumeransari/claude-show-your-work.git#releases');
});
test('a plugin loaded from a folder is never updated', async () => {
    const e = engine({ source: 'directory' });
    await checkForUpdate(e.$, '0.5.0');
    expect(args(e.runs)).toEqual(['plugin marketplace list --json']);
});
test('already fetched but not restarted: nothing more is done', async () => {
    const e = engine({ installed: '0.6.0' });
    await checkForUpdate(e.$, '0.5.0');
    expect(args(e.runs)).toEqual(['plugin marketplace list --json', 'plugin list --json']);
    expect(e.toasts.length).toBe(0);
});
test('a failed update says nothing to the user', async () => {
    const e = engine({ updateExit: 1 });
    await checkForUpdate(e.$, '0.5.0');
    expect(e.toasts.length).toBe(0);
});
test('when claude is not on the PATH it is found where it is usually installed', async () => {
    const e = engine({ missingBinaries: ['claude'] });
    await checkForUpdate(e.$, '0.5.0');
    expect(e.runs[0][0].endsWith('/claude')).toBe(true);
    expect(args(e.runs)).toContain('plugin update show-your-work@iamumeransari --scope user');
});
test('an old no to updates (0.5.12, 0.5.16) no longer stops them', async () => {
    for (const [key, value] of [['updatesOff', true], ['consent', { updates: false, stats: true }]]) {
        const e = engine({ latest: '0.6.1' });
        e.store.set(key, value);
        await checkForUpdate(e.$, '0.6.0', BRANCHES.stable);
        expect(e.fetched.length).toBe(1);
    }
});
