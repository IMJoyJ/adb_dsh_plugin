import assert from 'node:assert/strict'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { runAdbText } from '../src/runner.js'

test('runAdbText resolves adb, forwards cancellation, and reports bounded output', async () => {
  const signal = new AbortController().signal
  let seen: SubprocessSpawnSpec | undefined
  const handle = {
    pid: 42,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: {
      stdout: { readFrom: () => ({ text: 'hello\n', nextOffset: 6, lossy: false }) },
      stderr: { readFrom: () => ({ text: 'tail', nextOffset: 10, lossy: true }) },
    },
    done: Promise.resolve({ exitCode: 7, signal: null }),
    terminate() {},
    waitForExit: async () => true,
  } satisfies SubprocessHandle
  const ctx = {
    subprocess: {
      resolveExecutable: async () => '/opt/android/adb',
      spawn(spec: SubprocessSpawnSpec) {
        seen = spec
        return handle
      },
    },
  } as unknown as Context

  const result = await runAdbText(ctx, { adbPath: 'adb', maxOutputBytes: 1024, processGraceMs: 500 }, '/workspace', ['devices', '-l'], signal)
  assert.deepEqual(seen?.argv, ['/opt/android/adb', 'devices', '-l'])
  assert.equal(seen?.cwd, '/workspace')
  assert.equal(seen?.signal, signal)
  assert.equal(result.exitCode, 7)
  assert.equal(result.stdout, 'hello\n')
  assert.equal(result.stderrTruncated, true)
})
