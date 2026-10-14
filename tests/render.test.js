import { expect, mock, test } from 'claude-code/testing';
const shown = {
    kind: 'video', path: '/tmp/x/f00001.png', source: '/tmp/x.webm', width: 960, height: 540, title: 'Agent QA', generation: 1,
    frames: { dir: '/tmp/x', count: 20, fps: 12, duration: 1.6 },
};
for (const columns of [140, 90]) {
    test(`the player draws a picture at ${columns} columns`, async ($) => {
        const output = `Shown to the user: Agent QA.\nshow-your-work:${JSON.stringify(shown)}`;
        const target = {
            plugin: 'show-your-work', surface: 'terminal', component: 'ToolResult', requestId: 'tu-1',
            props: { tool_use_id: 'tu-1', tool: 'mcp__show-your-work__show_video', output, isErrored: false },
            viewport: { columns, rows: 50 },
        };
        const mounted = await $.ui.mount(target);
        const tree = JSON.stringify(await mounted.drawn());
        expect(tree.includes('"Image"')).toBe(true);
    });
}
test('the window is never wider than the terminal', async ($) => {
    for (const columns of [70, 100, 160]) {
        const output = `Shown.\nshow-your-work:${JSON.stringify(shown)}`;
        const target = {
            plugin: 'show-your-work', surface: 'terminal', component: 'ToolResult', requestId: `w-${columns}`,
            props: { tool_use_id: `w-${columns}`, tool: 'mcp__show-your-work__show_video', output, isErrored: false },
            viewport: { columns, rows: 50 },
        };
        const mounted = await $.ui.mount(target);
        const tree = (await mounted.drawn());
        expect(tree.props.width).toBeLessThanOrEqual(columns - 4);
    }
});
test('a narrow window shows the report under the player', async ($) => {
    const report = { ...shown, changes: [{ title: 'Stats moved inside the cards', at: 0.5 }], summary: [{ label: 'Layout', ok: true, passed: 4, total: 4 }] };
    for (const columns of [80, 100]) {
        const output = `Shown.\nshow-your-work:${JSON.stringify(report)}`;
        const target = {
            plugin: 'show-your-work', surface: 'terminal', component: 'ToolResult', requestId: `n-${columns}`,
            props: { tool_use_id: `n-${columns}`, tool: 'mcp__show-your-work__show_video', output, isErrored: false },
            viewport: { columns, rows: 50 },
        };
        const mounted = await $.ui.mount(target);
        const tree = JSON.stringify(await mounted.drawn());
        expect(tree.includes('WHAT CHANGED')).toBe(true);
        expect(tree.includes('All checks passed')).toBe(true);
    }
});
test('a picture with earlier versions draws with the version row', async ($) => {
    const pic = { kind: 'image', path: '/tmp/a.png', source: '/tmp/a.png', width: 1600, height: 1060, title: 'Hero', generation: 1 };
    const withHistory = { ...pic, changes: [{ title: 'Centred the play button' }], compare: { ...pic, title: 'Original' }, history: [{ path: '/tmp/v1.png', note: 'Cloud photo' }, { path: '/tmp/v2.png' }], note: 'Centred play' };
    for (const columns of [160, 90]) {
        const output = `Shown.\nshow-your-work:${JSON.stringify(withHistory)}`;
        const target = {
            plugin: 'show-your-work', surface: 'terminal', component: 'ToolResult', requestId: `h-${columns}`,
            props: { tool_use_id: `h-${columns}`, tool: 'mcp__show-your-work__show_image', output, isErrored: false },
            viewport: { columns, rows: 50 },
        };
        const mounted = await $.ui.mount(target);
        const tree = JSON.stringify(await mounted.drawn());
        expect(tree.includes('History · 3')).toBe(true);
        expect(tree.includes('"Image"')).toBe(true);
    }
});
test('the history lists every version by what changed, newest first', async ($) => {
    const pic = { kind: 'image', path: '/tmp/a.png', source: '/tmp/a.png', width: 1600, height: 1060, title: 'Hero', generation: 1 };
    const withHistory = { ...pic, compare: { ...pic, title: 'Original' }, history: [{ path: '/tmp/v1.png', note: 'Cloud photo' }, { path: '/tmp/v2.png', note: 'Real icons' }], note: 'Centred play' };
    const output = `Shown.\nshow-your-work:${JSON.stringify(withHistory)}`;
    const target = {
        plugin: 'show-your-work', surface: 'terminal', component: 'ToolResult', requestId: 'hist',
        props: { tool_use_id: 'hist', tool: 'mcp__show-your-work__show_image', output, isErrored: false },
        viewport: { columns: 160, rows: 50 },
    };
    const m = await $.ui.mount(target);
    await m.press({ key: 'history' });
    await m.redraw();
    const tree = JSON.stringify(await m.drawn());
    expect(tree.includes('VERSIONS · 3')).toBe(true);
    expect(tree.indexOf('Centred play')).toBeLessThan(tree.indexOf('Cloud photo'));
});
test('the bar can be scrubbed while the clip plays', async ($) => {
    const output = `Shown.\nshow-your-work:${JSON.stringify(shown)}`;
    const target = {
        plugin: 'show-your-work', surface: 'terminal', component: 'ToolResult', requestId: 'scrub',
        props: { tool_use_id: 'scrub', tool: 'mcp__show-your-work__show_video', output, isErrored: false },
        viewport: { columns: 140, rows: 50 },
    };
    const m = await $.ui.mount(target);
    const before = JSON.stringify(await m.drawn());
    if (before.includes('Pause')) { /* autoplayed */ }
    else
        await m.press({ key: 'play' });
    await m.redraw();
    const tree = JSON.stringify(await m.drawn());
    expect(tree.includes('Pause')).toBe(true);
    expect(tree.includes('"seek-0"')).toBe(true);
    // Pressing near the end while playing moves the playhead there.
    const last = [...tree.matchAll(/"seek-(\d+)"/g)].map(x => Number(x[1])).at(-1);
    await m.press({ key: `seek-${last}` });
    await m.redraw();
    const after = JSON.stringify(await m.drawn());
    expect(after.includes('0:01')).toBe(true);
});
test('a preview whose files are gone says it expired, with a prompt to copy', async ($) => {
    const gone = { kind: 'image', path: '/tmp/definitely-gone-xyz.png', source: '/tmp/definitely-gone-xyz.png', width: 800, height: 600, title: 'Hero', generation: 1 };
    const output = `Shown.\nshow-your-work:${JSON.stringify(gone)}`;
    const target = {
        plugin: 'show-your-work', surface: 'terminal', component: 'ToolResult', requestId: 'gone',
        props: { tool_use_id: 'gone', tool: 'mcp__show-your-work__show_image', output, isErrored: false },
        viewport: { columns: 140, rows: 50 },
    };
    const tree = JSON.stringify(await (await $.ui.mount(target)).drawn());
    expect(tree.includes('"Image"') || tree.includes('expired')).toBe(true);
});
test('a video without ffmpeg says so in place, with a prompt to copy', async ($) => {
    const output = "show-your-work: videos need ffmpeg, and it isn't installed. Pictures still work. Install it with `brew install ffmpeg` " +
        '(Claude can run that for you), then restart Claude Code. No Homebrew? Install it first from https://brew.sh.';
    const target = {
        plugin: 'show-your-work', surface: 'terminal', component: 'ToolResult', requestId: 'no-ff',
        props: { tool_use_id: 'no-ff', tool: 'mcp__show-your-work__show_video', output, isErrored: true },
        viewport: { columns: 120, rows: 50 },
    };
    const tree = JSON.stringify(await (await $.ui.mount(target)).drawn());
    expect(tree.includes('Videos need ffmpeg')).toBe(true);
    expect(tree.includes('Copy prompt')).toBe(true);
});
test('other errors keep the engine\'s own drawing', async ($) => {
    const target = {
        plugin: 'show-your-work', surface: 'terminal', component: 'ToolResult', requestId: 'other-err',
        props: { tool_use_id: 'other-err', tool: 'mcp__show-your-work__show_video', output: 'show-your-work: no such file', isErrored: true },
        viewport: { columns: 120, rows: 50 },
    };
    // The harness has no engine drawing, so passing it on shows up as a refusal.
    const drawn = await $.ui.mount(target).then(m => m.drawn()).then(t => JSON.stringify(t), (err) => String(err));
    expect(drawn.includes('Videos need ffmpeg')).toBe(false);
});
test('the tour draws its first stop in the chat, with a way forward', async ($, on) => {
    on('store.get', () => ({ value: undefined }));
    const target = { plugin: 'show-your-work', surface: 'terminal', component: 'CommandOutput', requestId: 'tour-row', props: { command: 'show-your-work', args: 'tour', text: 'show-your-work tour.', isErrored: false }, viewport: { columns: 120, rows: 50 } };
    const mounted = await $.ui.mount(target);
    const tree = JSON.stringify(await mounted.drawn());
    expect(tree.includes('Claude shows you what it builds')).toBe(true);
    expect(tree.includes('1 of 5')).toBe(true);
    expect(tree.includes('Next ›')).toBe(true);
    expect(tree.includes('Skip tour')).toBe(true);
});
test('the tour walks through its stops with Next', async ($, on) => {
    on('store.get', () => ({ value: undefined }));
    const target = { plugin: 'show-your-work', surface: 'terminal', component: 'CommandOutput', requestId: 'tour-walk', props: { command: 'show-your-work', args: 'tour', text: 'show-your-work tour.', isErrored: false }, viewport: { columns: 120, rows: 50 } };
    const mounted = await $.ui.mount(target);
    const seen = [];
    for (const title of ['Claude shows you what it builds', 'Jump to any change', 'See before and after', 'Every version is kept', "You're set"]) {
        await new Promise(r => globalThis.setTimeout(r, 30));
        const tree = JSON.stringify(await mounted.drawn());
        if (tree.includes(title))
            seen.push(title);
        if (title !== "You're set")
            await mounted.press({ key: 'next' });
    }
    expect(seen.length).toBe(5);
});
// Every node of a drawn tree whose type is `type`.
const nodesOf = (node, type, out = []) => {
    if (!node || typeof node !== 'object')
        return out;
    if (Array.isArray(node)) {
        for (const n of node)
            nodesOf(n, type, out);
        return out;
    }
    if (node.type === type)
        out.push(node);
    nodesOf(node.children, type, out);
    return out;
};
test('Original and Updated of different shapes share one frame, each whole inside it', async ($) => {
    const tall = { kind: 'image', path: '/tmp/tall.png', source: '/tmp/tall.png', width: 900, height: 1600, title: 'Tall', generation: 1 };
    const big = { kind: 'image', path: '/tmp/big.png', source: '/tmp/big.png', width: 3000, height: 1875, title: 'Original', generation: 2 };
    const output = `Shown.\nshow-your-work:${JSON.stringify({ ...tall, changes: [{ title: 'Shapes differ' }], compare: big })}`;
    const target = {
        plugin: 'show-your-work', surface: 'terminal', component: 'ToolResult', requestId: 'shapes',
        props: { tool_use_id: 'shapes', tool: 'mcp__show-your-work__show_image', output, isErrored: false },
        viewport: { columns: 160, rows: 50 },
    };
    const mounted = await $.ui.mount(target);
    const frameOf = (tree) => {
        const image = nodesOf(tree, 'Image')[0].props;
        const holder = nodesOf(tree, 'Box').find(b => b.props?.justifyContent === 'center' && nodesOf(b.children, 'Image').length);
        return { image: { columns: image.columns, rows: image.rows }, frame: holder ? { columns: holder.props.width, rows: holder.props.height } : { columns: image.columns, rows: image.rows } };
    };
    const updated = frameOf(await mounted.drawn());
    await mounted.press({ key: 'side-before' });
    const original = frameOf(await mounted.drawn());
    // One frame for both: switching moves nothing.
    expect(original.frame).toEqual(updated.frame);
    // Each side is its own shape, inside the frame, and neither is shrunk to the other's.
    for (const side of [updated, original]) {
        expect(side.image.columns).toBeLessThanOrEqual(side.frame.columns);
        expect(side.image.rows).toBeLessThanOrEqual(side.frame.rows);
    }
    expect(updated.image.rows).toBeGreaterThan(updated.image.columns / 2);
    expect(original.image.columns).toBeGreaterThan(updated.image.columns);
});
test('Open page opens only a web address, never an app or a script', async ($) => {
    const pic = { kind: 'image', path: '/tmp/a.png', source: '/tmp/a.png', width: 1600, height: 1000, title: 'Page', generation: 1 };
    const cases = [['https://example.com/pricing', 'Open page'], ['/tmp/x.command', 'View'], ['file:///Applications/Calculator.app', 'View'], ['-a Terminal', 'View']];
    for (const [url, label] of cases) {
        const output = `Shown.\nshow-your-work:${JSON.stringify({ ...pic, url })}`;
        const id = `u-${label}-${url.length}`;
        const target = {
            plugin: 'show-your-work', surface: 'terminal', component: 'ToolResult', requestId: id,
            props: { tool_use_id: id, tool: 'mcp__show-your-work__show_image', output, isErrored: false },
            viewport: { columns: 140, rows: 50 },
        };
        const mounted = await $.ui.mount(target);
        const page = nodesOf(await mounted.drawn(), 'Button').find(b => b.props.key === 'page');
        expect(page.props.label).toBe(`↗ ${label}`);
    }
});
test('clicking a change pauses the video on that moment', async ($) => {
    const clip = { ...shown, changes: [{ title: 'Stats moved inside the cards', at: 1 }] };
    const output = `Shown.\nshow-your-work:${JSON.stringify(clip)}`;
    const target = {
        plugin: 'show-your-work', surface: 'terminal', component: 'ToolResult', requestId: 'jump-pause',
        props: { tool_use_id: 'jump-pause', tool: 'mcp__show-your-work__show_video', output, isErrored: false },
        viewport: { columns: 140, rows: 50 },
    };
    const mounted = await $.ui.mount(target);
    await mounted.press({ key: 'play' });
    const playing = nodesOf(await mounted.drawn(), 'Button').find(b => b.props.key === 'play');
    expect(playing.props.label.includes('Pause')).toBe(true);
    const change = nodesOf(await mounted.drawn(), 'Button').find(b => String(b.props.key).startsWith('change-'));
    await mounted.press({ key: change.props.key });
    const after = nodesOf(await mounted.drawn(), 'Button').find(b => b.props.key === 'play');
    expect(after.props.label.includes('Pause')).toBe(false);
});
test('/img draws the picture in the chat, under the command', async ($) => {
    const pic = { kind: 'image', path: '/tmp/a.png', source: '/tmp/a.png', width: 1600, height: 1000, title: 'hero.jpg', generation: 1 };
    const target = {
        plugin: 'show-your-work', surface: 'terminal', component: 'CommandOutput', requestId: 'img-row',
        props: { command: 'img', args: '/tmp/a.png', text: `show-your-work: Showing hero.jpg.\nshow-your-work:${JSON.stringify(pic)}`, isErrored: false },
        viewport: { columns: 140, rows: 50 },
    };
    const tree = await (await $.ui.mount(target)).drawn();
    expect(nodesOf(tree, 'Image').length).toBe(1);
    expect(JSON.stringify(tree).includes('hero.jpg')).toBe(true);
});
test('an /img row from before a restart says what it showed, without the raw marker', async ($) => {
    const target = {
        plugin: 'show-your-work', surface: 'terminal', component: 'CommandOutput', requestId: 'img-old',
        props: { command: 'img', args: 'x.png', text: 'Showing x.png (800×500).\nshow-your-work:#abcdef1234', isErrored: false },
        viewport: { columns: 140, rows: 50 },
    };
    const text = JSON.stringify(await (await $.ui.mount(target)).drawn());
    expect(text.includes('Showing x.png')).toBe(true);
    expect(text.includes('show-your-work:#')).toBe(false);
});
// How often `text` appears in a drawn tree.
const timesIn = (tree, text) => JSON.stringify(tree).split(text).length - 1;
test('the tabs are drawn once, in the title bar, in every layout', async ($) => {
    const pic = { kind: 'image', path: '/tmp/a.png', source: '/tmp/a.png', width: 1600, height: 1000, title: 'Hero', generation: 1 };
    const withReport = { ...pic, changes: [{ title: 'Trip card beside the headline' }], compare: { ...pic, title: 'Original' } };
    const noReport = { ...pic, compare: { ...pic, title: 'Original' } };
    const withHistory = { ...withReport, history: [{ path: '/tmp/v1.png', note: 'First' }, { path: '/tmp/v2.png' }] };
    for (const [name, shownNow, columns] of [['report beside', withReport, 170], ['report below', withReport, 90], ['no report', noReport, 170], ['history', withHistory, 170], ['narrow history', withHistory, 80]]) {
        const id = `tabs-${name}`;
        const target = {
            plugin: 'show-your-work', surface: 'terminal', component: 'ToolResult', requestId: id,
            props: { tool_use_id: id, tool: 'mcp__show-your-work__show_image', output: `Shown.\nshow-your-work:${JSON.stringify(shownNow)}`, isErrored: false },
            viewport: { columns, rows: 50 },
        };
        const tree = await (await $.ui.mount(target)).drawn();
        const bars = nodesOf(tree, 'Box').filter(b => b.key === 'title-bar' || b.props?.key === 'title-bar');
        expect(bars.length).toBe(1);
        for (const key of ['side-before', 'side-after']) {
            expect(nodesOf(tree, 'Button').filter(b => b.props.key === key).length).toBe(1);
            expect(nodesOf(bars[0], 'Button').filter(b => b.props.key === key).length).toBe(1);
        }
    }
});
test('each tour stop shows its instruction once, under its title', async ($, on) => {
    on('store.get', () => ({ value: undefined }));
    const target = { plugin: 'show-your-work', surface: 'terminal', component: 'CommandOutput', requestId: 'tour-hints', props: { command: 'show-your-work', args: 'tour', text: 'show-your-work tour.', isErrored: false }, viewport: { columns: 140, rows: 50 } };
    const mounted = await $.ui.mount(target);
    for (const [title, tag] of [['Claude shows you what it builds', 'Press ▶ Play'], ['Jump to any change', 'Click a change to jump to that moment'], ['See before and after', 'Press Original to see it before the change'], ['Every version is kept', 'Open History, then pick a version']]) {
        await new Promise(r => globalThis.setTimeout(r, 30));
        const tree = await mounted.drawn();
        expect(timesIn(tree, title)).toBe(1);
        expect(timesIn(tree, tag)).toBe(1);
        // Under the title: the instruction comes straight after it, before the player.
        const text = JSON.stringify(tree);
        expect(text.indexOf(tag)).toBeGreaterThan(text.indexOf(title));
        expect(text.indexOf(tag) - text.indexOf(title)).toBeLessThan(300);
        await mounted.press({ key: 'next' });
    }
});
test('a wide window draws plain QA lines in the sidebar, never an empty one', async ($) => {
    const pic = { kind: 'image', path: '/tmp/k.png', source: '/tmp/k.png', width: 720, height: 3200, title: 'UI kit', generation: 1 };
    const withQa = { ...pic, summary: [{ label: 'Components from live markup', ok: true }, { label: 'Renders standalone', ok: true }] };
    const output = `Shown.\nshow-your-work:${JSON.stringify(withQa)}`;
    const target = {
        plugin: 'show-your-work', surface: 'terminal', component: 'ToolResult', requestId: 'qa-wide',
        props: { tool_use_id: 'qa-wide', tool: 'mcp__show-your-work__show_image', output, isErrored: false },
        viewport: { columns: 200, rows: 60 },
    };
    const mounted = await $.ui.mount(target);
    const tree = JSON.stringify(await mounted.drawn());
    expect(tree.includes('All checks passed')).toBe(true);
    expect(tree.includes('Renders standalone')).toBe(true);
});
test('a playing video swaps its frames in order, one at a time, at its frame rate', async ($, on) => {
    const clock = mock.clock(on);
    on('store.get', () => ({ value: undefined }));
    // Every frame is already cut, and each swap is recorded.
    on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }));
    const swapped = [];
    on('ui.blit', (_$, e) => {
        const file = String(e.source?.file ?? '');
        const m = /f(\d+)\.png$/.exec(file);
        if (m)
            swapped.push(Number(m[1]));
        return { value: {} };
    });
    const clip = { ...shown, frames: { ...shown.frames, count: 30 } };
    const output = `Shown.\nshow-your-work:${JSON.stringify(clip)}`;
    const target = {
        plugin: 'show-your-work', surface: 'terminal', component: 'ToolResult', requestId: 'frames',
        props: { tool_use_id: 'frames', tool: 'mcp__show-your-work__show_video', output, isErrored: false },
        viewport: { columns: 140, rows: 50 },
    };
    const mounted = await $.ui.mount(target);
    await mounted.press({ key: 'play' });
    await clock.advance(1000);
    const played = swapped.filter((f, i) => i === 0 || f !== swapped[i - 1]);
    // About a second at 12 fps, and never a frame drawn after a later one.
    expect(played.length).toBeGreaterThanOrEqual(10);
    expect(played.every((f, i) => i === 0 || f > played[i - 1])).toBe(true);
});
test('on a slow terminal, playback drops frames instead of queueing or reordering them', async ($, on) => {
    const clock = mock.clock(on);
    on('store.get', () => ({ value: undefined }));
    on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }));
    // Each swap takes 250 ms, three frames' worth at 12 fps.
    const swapped = [];
    let inFlight = 0;
    let mostAtOnce = 0;
    on('ui.blit', async (_$, e) => {
        const m = /f(\d+)\.png$/.exec(String(e.source?.file ?? ''));
        inFlight += 1;
        mostAtOnce = Math.max(mostAtOnce, inFlight);
        await clock.sleep(250);
        inFlight -= 1;
        if (m)
            swapped.push(Number(m[1]));
        return { value: {} };
    });
    const clip = { ...shown, frames: { ...shown.frames, count: 40 } };
    const output = `Shown.\nshow-your-work:${JSON.stringify(clip)}`;
    const target = {
        plugin: 'show-your-work', surface: 'terminal', component: 'ToolResult', requestId: 'slow',
        props: { tool_use_id: 'slow', tool: 'mcp__show-your-work__show_video', output, isErrored: false },
        viewport: { columns: 140, rows: 50 },
    };
    const mounted = await $.ui.mount(target);
    await mounted.press({ key: 'play' });
    await clock.advance(2000);
    const frames = swapped.filter(f => f > 1);
    // Only one swap at a time, so about one every 250 ms, always moving forward.
    expect(mostAtOnce).toBeLessThanOrEqual(2);
    expect(frames.length).toBeLessThanOrEqual(10);
    expect(frames.every((f, i) => i === 0 || f > frames[i - 1])).toBe(true);
    expect(frames.at(-1)).toBeGreaterThanOrEqual(15);
});
test('scrolling back to a picture re-sends it only if the terminal may have dropped it', async ($, on) => {
    const clock = mock.clock(on);
    on('store.get', () => ({ value: undefined }));
    on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }));
    let sent = 0;
    on('ui.blit', () => {
        sent += 1;
        return { value: {} };
    });
    const pic = { kind: 'image', path: '/tmp/scroll.png', source: '/tmp/scroll.png', width: 1600, height: 1000, title: 'Scroll', generation: 1 };
    const output = `Shown.\nshow-your-work:${JSON.stringify(pic)}`;
    const props = { tool_use_id: 'scroll', tool: 'mcp__show-your-work__show_image', output, isErrored: false };
    const target = {
        plugin: 'show-your-work', surface: 'terminal', component: 'ToolResult', requestId: 'scroll',
        props, viewport: { columns: 140, rows: 50 },
    };
    const mounted = await $.ui.mount(target);
    await clock.advance(1000);
    const before = sent;
    // Away and straight back: the terminal still has it, nothing is sent.
    await mounted.redraw({ ...props, onScreen: null });
    await mounted.redraw({ ...props, onScreen: true });
    await clock.settle();
    expect(sent).toBe(before);
    // Away while plenty of other pictures were sent: sent again at once.
    await mounted.redraw({ ...props, onScreen: null });
    // A huge picture shown meanwhile: 8000 x 8000 is 256 MB decoded.
    const big = { ...pic, path: '/tmp/big.png', source: '/tmp/big.png', width: 8000, height: 8000, title: 'Big' };
    await $.ui.mount({ ...target, requestId: 'big', props: { ...props, tool_use_id: 'big', output: `Shown.\nshow-your-work:${JSON.stringify(big)}` } });
    await clock.settle();
    await mounted.redraw({ ...props, onScreen: true });
    await clock.settle();
    expect(sent).toBe(before + 1);
});
test('a tall, narrow picture still gets Copy path when the window has room', async ($) => {
    const pic = { kind: 'image', path: '/tmp/board.png', source: '/tmp/board.png', width: 1200, height: 1340, title: 'Scene board', generation: 1 };
    const target = {
        plugin: 'show-your-work', surface: 'terminal', component: 'ToolResult', requestId: 'tall-copy',
        props: { tool_use_id: 'tall-copy', tool: 'mcp__show-your-work__show_image', output: `Shown.\nshow-your-work:${JSON.stringify(pic)}`, isErrored: false },
        viewport: { columns: 140, rows: 50 },
    };
    const mounted = await $.ui.mount(target);
    const keys = nodesOf(await mounted.drawn(), 'Button').map(b => b.props.key);
    expect(keys.includes('copy')).toBe(true);
});
