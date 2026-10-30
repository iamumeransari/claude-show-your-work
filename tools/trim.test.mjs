// Tests for HISTORY_TRIM_SH in hooks/history.ts: it runs in a project folder
// and must only ever delete the plugin's own records (#19).
// Run with: node --test tools/
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// The script, read from the source so the test needs no TypeScript.
const source = readFileSync(join(import.meta.dirname, '..', 'hooks', 'history.ts'), 'utf8')
const lines = source.match(/export const HISTORY_TRIM_SH = \[([\s\S]*?)\]\.join/)[1]
const TRIM = new Function(`return [${lines.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')}]`)().join('\n')

// GNU coreutils stat, on any system: -f is --file-system, so `stat -f %m f`
// prints a report for f and fails on the operand %m.
const realStat = spawnSync('stat', ['-c', '%Y', '/'], { encoding: 'utf8' }).status === 0
  ? `exec /usr/bin/env -u PATH stat "$@"`
  : `[ "$1" = "-c" ] && exec /usr/bin/stat -f %m "$3"; exec /usr/bin/stat "$@"`
const GNU_STAT = `#!/bin/sh
if [ "$1" = "-f" ]; then printf '  File: "%s"\\n    ID: 26 Namelen: 255\\nBlock size: 4096\\n' "$3"; echo "stat: cannot read '%m'" >&2; exit 1; fi
${realStat}
`

function project(withGnuStat) {
  const dir = mkdtempSync(join(tmpdir(), 'trim-test-'))
  const store = join(dir, '.show-your-work')
  mkdirSync(store)
  for (const name of ['.gitignore', '.env', 'keep.txt']) writeFileSync(join(dir, name), 'x')
  // Three 400 KB versions, oldest first.
  ;['aaaaa1', 'aaaaa2', 'aaaaa3'].forEach((id, i) => {
    writeFileSync(join(store, `${id}.png`), Buffer.alloc(400_000))
    writeFileSync(join(store, `${id}.json`), '{}')
    const t = 1_700_000_000 + i * 60
    utimesSync(join(store, `${id}.json`), t, t)
  })
  const env = { ...process.env }
  if (withGnuStat) {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'stat'), GNU_STAT)
    chmodSync(join(bin, 'stat'), 0o755)
    env.PATH = `${bin}:${env.PATH}`
  }
  const r = spawnSync('sh', ['-c', TRIM, 'trim', '500', join(store, 'aaaaa3.json'), store], { cwd: dir, env, encoding: 'utf8' })
  return { dir, store, r }
}

for (const withGnuStat of [false, true]) {
  test(`trim keeps the project's dot-files and deletes the oldest versions${withGnuStat ? ', with GNU stat' : ''}`, () => {
    const { dir, store, r } = project(withGnuStat)
    assert.equal(r.status, 0, r.stderr)
    for (const name of ['.gitignore', '.env', 'keep.txt']) assert.ok(existsSync(join(dir, name)), `${name} was deleted`)
    assert.ok(!existsSync(join(store, 'aaaaa1.png')) && !existsSync(join(store, 'aaaaa1.json')), 'the oldest version was kept')
    assert.ok(existsSync(join(store, 'aaaaa3.png')), 'the version just kept was deleted')
  })
}
