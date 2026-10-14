// The tour's stops, and how a press in the player ticks the one it asked for.
import { atom, update } from 'claude-code';
import { state } from './state';
// The settings pane's and the tour's redraws. Declared in each file that
// reads or updates it: the engine only reads an atom declared in the same file.
const welcome = atom({ plugin: 'show-your-work', key: 'welcome' }, 0);
export const STOPS = [
    { title: 'Claude shows you what it builds', tag: 'Press ▶ Play', spot: 'play', goal: 'play', media: 'splash' },
    { title: 'Jump to any change', tag: 'Click a change to jump to that moment', spot: 'changes', goal: 'change_jump', media: 'recording' },
    { title: 'See before and after', tag: 'Press Original to see it before the change', spot: 'tabs', goal: 'original', media: 'compare' },
    { title: 'Every version is kept', tag: 'Open History, then pick a version', spot: 'history', goal: 'version_pick', media: 'history' },
    { title: "You're set", tag: 'Try asking Claude to create something and show it to you in the chat, as an image or a recording.' },
];
// A button press, heard: when it is what the stop asked for, it ticks; the
// person moves on with Next when they're ready.
export function tourHeard($, action) {
    const s = STOPS[state.tourStop];
    if (!state.tourSite || state.isTourDone || state.isStopDone || !s?.goal || s.goal !== action)
        return;
    state.isStopDone = true;
    void update($, welcome, n => n + 1);
}
