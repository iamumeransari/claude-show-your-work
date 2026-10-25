import { expect, test } from 'claude-code/testing'

import { diagnosis, isWiderThanBox, problem, problems } from '../hooks/diagnostics'

test('a frame wider than its box is caught, within the 3% the copies allow', () => {
  // 63 columns of 16 px hold 1008 px: a 1000 px copy fits, a 1600 px one is cropped.
  expect(isWiderThanBox(1000, 63, 16)).toBe(false)
  // 3% over, plus the column the box was rounded down by, is allowed on purpose.
  expect(isWiderThanBox(1670, 101, 16.04)).toBe(false)
  expect(isWiderThanBox(1600, 63, 16)).toBe(true)
})

test('diagnose groups recent problems, newest ten minutes only', () => {
  const now = 1_000_000_000
  const kept = [
    { t: now - 20 * 60_000, what: 'old_one' },
    { t: now - 60_000, what: 'frame_wider_than_box' },
    { t: now - 30_000, what: 'frame_wider_than_box' },
    { t: now - 1_000, what: 'resend_cancelled' },
  ]
  const text = diagnosis(now, kept, true, '/tmp/x/debug.log')
  expect(text).toContain('3 problems in the last 10 minutes')
  expect(text).toContain('frame_wider_than_box × 2')
  expect(text).toContain('resend_cancelled × 1')
  expect(text.includes('old_one')).toBe(false)
  expect(text).toContain('Full log: /tmp/x/debug.log')
})

test('diagnose says how to get a full log when it is off, and when all is well', () => {
  const text = diagnosis(5_000_000, [], false)
  expect(text).toContain('No problems noticed')
  expect(text).toContain('SHOW_YOUR_WORK_DEBUG=1')
})

test('problems are kept even with the debug log off, and capped', () => {
  const before = problems.length
  problem('test_problem', { n: 1 })
  expect(problems.length).toBe(before + 1)
  expect(problems.at(-1)?.what).toBe('test_problem')
  for (let i = 0; i < 400; i++) problem('test_flood')
  expect(problems.length <= 300).toBe(true)
})
