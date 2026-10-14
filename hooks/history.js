import { state } from './state';
import { expand, keyOf, prepare, VIDEO } from './media';
export const MARK = 'show-your-work:';
// A time is only worth a click when it points somewhere: a picture has no
// timeline, and a clip where every change sits at the same second isn't
// pointing anywhere either. Those rows are plain text.
export function timesThatMean(changes, isVideo) {
    if (!changes)
        return changes;
    const times = new Set(changes.filter(c => c.at !== undefined).map(c => c.at));
    const isPointing = isVideo && (times.size > 1 || (times.size === 1 && changes.length === 1));
    return isPointing ? changes : changes.map(({ at: _, ...c }) => c);
}
// The line a version is listed by: what changed in it.
// A version's label: its first change, and how many more there were.
export function noteOf(changes, change, title) {
    const titles = (changes ?? []).map(c => c.title.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const more = titles.length > 1 ? ` and ${titles.length - 1} more` : '';
    return (titles.length ? titles[0] + more : change ?? title ?? '').slice(0, 200);
}
// Earlier versions as given: paths or { path, note }, as an array or the
// same array sent as JSON text.
export function versionsOf(value) {
    if (typeof value === 'string') {
        const text = value;
        try {
            value = JSON.parse(text);
        }
        catch {
            return text ? [{ path: text }] : [];
        }
    }
    if (!Array.isArray(value))
        return [];
    return value.flatMap(v => typeof v === 'string' ? [{ path: v }]
        : v && typeof v === 'object' && typeof v.path === 'string'
            ? [{ path: v.path, note: typeof v.note === 'string' ? v.note : undefined }]
            : []);
}
export const handleOf = (value) => (typeof value === 'string' ? value.trim().replace(/^#/, '').toLowerCase() : '') || undefined;
let storeDir = '';
// Everything the plugin keeps is at most 1 GB: 500 MB of frames (a cache, cut
// again when needed) and 500 MB of history across every project together.
const HISTORY_CAP_KB = 500000;
// Every history folder this install has used, so the cap spans all of them.
const HISTORY_DIRS = 'historyDirs';
// Deletes the oldest versions across the history folders in $3… until they
// hold $1 KB at most, never the one just kept ($2); only folders this user
// owns, never through a link, only the plugin's own record names.
export const HISTORY_TRIM_SH = [
    'cap=$1 keep=$2; shift 2',
    'ok() { [ -d "$1" ] && [ ! -L "$1" ] && [ -O "$1" ]; }',
    'total=0; for d in "$@"; do ok "$d" && total=$((total + $(du -sk "$d" | cut -f1))); done',
    '[ "$total" -le "$cap" ] && exit 0',
    'R="[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]"',
    'for d in "$@"; do ok "$d" || continue; for f in "$d"/$R.json; do [ -f "$f" ] && printf "%s\\t%s\\n" "$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f")" "$f"; done; done |',
    '  sort -n | while IFS="$(printf "\\t")" read -r t f; do',
    '    [ "$total" -le "$cap" ] && break',
    '    [ "$f" = "$keep" ] && continue',
    '    base=${f%.json}; size=$(du -sk "$base".* 2>/dev/null | awk \'{s += $1} END {print s + 0}\'); rm -f -- "$base".*; total=$((total - size))',
    '  done; true',
].join('\n');
export async function storeOf($) {
    if (storeDir)
        return storeDir;
    for (const dir of [`${state.cwd || state.home}/.show-your-work`, `${state.TMP}/store`]) {
        // Never through a link (a repo could commit `.show-your-work -> ..`), and
        // only a folder this user owns.
        const r = await $.process.run(['sh', '-c', '[ -L "$0" ] && exit 1; mkdir -p "$0" && [ ! -L "$0" ] && [ -O "$0" ] && { [ -f "$0/.gitignore" ] || printf "*\\n" > "$0/.gitignore"; }', dir]).catch(() => null);
        if (r && r.exitCode === 0) {
            const dirs = (await $.store.get(HISTORY_DIRS)) ?? [];
            if (!dirs.includes(dir))
                await $.store.set(HISTORY_DIRS, [dir, ...dirs].slice(0, 200));
            return (storeDir = dir);
        }
    }
    return (storeDir = `${state.TMP}/store`);
}
async function readVersion($, dir, id) {
    if (!/^[0-9a-f]{4,12}$/.test(id))
        return null;
    const r = await $.process.run(['cat', `${dir}/${id}.json`]).catch(() => null);
    if (!r || r.exitCode !== 0)
        return null;
    // A record's id and extension become paths that are later deleted: only
    // the plugin's own shapes pass.
    try {
        const v = JSON.parse(r.stdout);
        return /^[0-9a-f]{4,12}$/.test(v.id) && /^(\.[A-Za-z0-9]{1,5})?$/.test(v.ext ?? '') ? v : null;
    }
    catch {
        return null;
    }
}
export async function storeVersion($, raw, note, title, parent) {
    const real = (await $.fs.stat(expand(raw, state.cwd, state.home), { resolve: true })).realPath ?? expand(raw, state.cwd, state.home);
    const dir = await storeOf($);
    const ext = real.match(/\.[^./]+$/)?.[0] ?? '';
    state.generation += 1;
    const id = keyOf(`${real}|${await $.clock.now()}|${state.generation}`).slice(0, 6);
    const meta = { id, ...(parent ? { parent } : {}), note, ext, title, origin: real };
    const r = await $.process.run(['sh', '-c',
        '[ ! -L "$0" ] && [ -O "$0" ] || exit 1\n' +
            'cp -c "$1" "$0/$2$3" 2>/dev/null || cp --reflink=auto "$1" "$0/$2$3" 2>/dev/null || cp "$1" "$0/$2$3" || exit 1\n' +
            'printf "%s" "$4" > "$0/$2.json"\n' +
            // Pictures and videos alike: kept 7 days, at most the newest 50 a
            // project; the oldest go first, file and record together. Inside the
            // store, by bare name: a path with spaces never reaches rm.
            'cd -P "$0" || exit 0\n' +
            'R="[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]"\n' +
            'find . -maxdepth 1 -name "$R.json" -mtime +7 | while IFS= read -r f; do f=${f#./}; rm -f "./${f%.json}".*; done\n' +
            'ls -t -- $R.json 2>/dev/null | tail -n +51 | while IFS= read -r f; do rm -f "./${f%.json}".*; done; true',
        dir, real, id, ext, JSON.stringify(meta)]);
    if (r.exitCode !== 0)
        return { real, copy: real, id, chain: [] };
    // Then the cap across every project's history.
    const dirs = (await $.store.get(HISTORY_DIRS)) ?? [dir];
    void $.process.run(['sh', '-c', HISTORY_TRIM_SH, 'trim', String(HISTORY_CAP_KB), `${dir}/${id}.json`, ...dirs]).catch(() => undefined);
    // Follow the links back, oldest first.
    const chain = [];
    let at = parent, missing;
    for (let n = 0; at && n < 30; n++) {
        const v = await readVersion($, dir, at);
        if (!v) {
            if (n === 0)
                missing = at;
            break;
        }
        chain.unshift({ path: `${dir}/${v.id}${v.ext}`, note: v.note, id: v.id });
        at = v.parent;
    }
    // A recording keeps only itself and the one before it: Original and
    // Updated, no deeper history, so re-recordings don't pile up.
    if (VIDEO.test(real) && chain.length > 1) {
        const older = chain.slice(0, -1);
        void $.process.run(['rm', '-f', ...older.map(v => v.path)]).catch(() => undefined);
        chain.splice(0, chain.length - 1);
    }
    return { real, copy: `${dir}/${id}${ext}`, id, chain, missing };
}
// The tool's text result carries the shown item as `show-your-work:{json}`;
// the output may be that string or a list of text blocks.
// A tool result's text, whether it came as a string or as content blocks.
export function textOf(output) {
    return typeof output === 'string'
        ? output
        : Array.isArray(output)
            ? output.map(b => (b && typeof b === 'object' && 'text' in b ? String(b.text) : '')).join('\n')
            : '';
}
// What a show drew, kept out of Claude's context: the result carries only
// "show-your-work:#id", and the data waits here and in the store beside the copy.
export const shownById = new Map();
// The marker is the last line: a command's row also starts with the plugin's name.
export const markOf = (output) => textOf(output).split('\n').findLast(l => l.startsWith(MARK))?.slice(MARK.length).trim();
export async function shownOf($, output) {
    const mark = markOf(output);
    if (!mark?.startsWith('#'))
        return parseShown(output);
    const id = mark.slice(1);
    if (!/^[0-9a-f]{4,12}$/.test(id))
        return null;
    const known = shownById.get(id);
    if (known)
        return known;
    const r = await $.process.run(['cat', `${await storeOf($)}/${id}.shown`]).catch(() => null);
    if (!r || r.exitCode !== 0)
        return null;
    try {
        const shown = JSON.parse(r.stdout);
        shownById.set(id, shown);
        return shown;
    }
    catch {
        return null;
    }
}
export function parseShown(output) {
    const text = textOf(output);
    const line = text.split('\n').findLast(l => l.startsWith(MARK));
    if (!line)
        return null;
    try {
        return JSON.parse(line.slice(line.indexOf(':') + 1));
    }
    catch {
        return null;
    }
}
// Kept copies never change, so each is read once, when first stepped to.
export const prepared = new Map();
export async function preparedOf($, path) {
    const known = prepared.get(path);
    if (known)
        return known;
    const made = await prepare($, path, 'Original');
    remember(path, made);
    return made;
}
// Entries are a path and a size, not pixels; the oldest go past 200.
export function remember(path, made) {
    prepared.set(path, made);
    if (prepared.size > 200)
        prepared.delete(prepared.keys().next().value);
}
