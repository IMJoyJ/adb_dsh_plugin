import type { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-subprocess'

/** Process-related configuration consumed by the ADB runner. */
export interface AdbRunnerConfig {
  adbPath: string
  maxOutputBytes: number
  processGraceMs: number
}

/** Bounded text result from one ADB invocation. */
export interface AdbTextResult {
  argv: string[]
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
}

/** Bounded binary result from one ADB invocation. */
export interface AdbBinaryResult {
  argv: string[]
  exitCode: number | null
  signal: string | null
  stdout: Uint8Array
  stderr: string
  stderrTruncated: boolean
}

function classifyOutcome(outcome: SubprocessOutcome): Pick<AdbTextResult, 'exitCode' | 'signal'> {
  return { exitCode: outcome.exitCode, signal: outcome.signal }
}

async function spawnAdb(
  ctx: Context,
  config: AdbRunnerConfig,
  workdir: string,
  argv: readonly string[],
  signal: AbortSignal,
  stdout: SubprocessSpawnSpec['stdio']['stdout'],
): Promise<SubprocessHandle> {
  signal.throwIfAborted()
  const executable = await ctx.subprocess.resolveExecutable(config.adbPath, undefined, signal)
  return ctx.subprocess.spawn({
    argv: [executable, ...argv],
    cwd: workdir,
    stdio: {
      stdin: 'ignore',
      stdout,
      stderr: { maxBytes: config.maxOutputBytes },
    },
    graceMs: config.processGraceMs,
    signal,
  })
}

/** Execute ADB with collected UTF-8 stdout/stderr. */
export async function runAdbText(
  ctx: Context,
  config: AdbRunnerConfig,
  workdir: string,
  argv: readonly string[],
  signal: AbortSignal,
): Promise<AdbTextResult> {
  const handle = await spawnAdb(ctx, config, workdir, argv, signal, { maxBytes: config.maxOutputBytes })
  const outcome = await handle.done
  signal.throwIfAborted()
  const stdout = handle.collected.stdout?.readFrom(0)
  const stderr = handle.collected.stderr?.readFrom(0)
  if (stdout === undefined || stderr === undefined) throw new Error('ADB process did not expose collected output')
  return {
    argv: [...argv],
    ...classifyOutcome(outcome),
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutTruncated: stdout.lossy,
    stderrTruncated: stderr.lossy,
  }
}

async function collectBytes(stream: Readable, maxBytes: number, handle: SubprocessHandle): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    total += bytes.byteLength
    if (total > maxBytes) {
      handle.terminate()
      throw new Error(`ADB binary output exceeded the ${maxBytes}-byte limit`)
    }
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, total)
}

/** Execute ADB with bounded raw stdout, used for screenshots. */
export async function runAdbBinary(
  ctx: Context,
  config: AdbRunnerConfig,
  workdir: string,
  argv: readonly string[],
  signal: AbortSignal,
  maxBytes: number,
): Promise<AdbBinaryResult> {
  const handle = await spawnAdb(ctx, config, workdir, argv, signal, 'pipe')
  if (handle.stdout === undefined) throw new Error('ADB process did not expose piped stdout')
  const bytesPromise = collectBytes(handle.stdout, maxBytes, handle)
  let outcome: SubprocessOutcome
  let stdout: Uint8Array
  try {
    ;[outcome, stdout] = await Promise.all([handle.done, bytesPromise])
  } catch (error: unknown) {
    handle.terminate()
    await handle.done.catch(() => {})
    throw error
  }
  signal.throwIfAborted()
  const stderr = handle.collected.stderr?.readFrom(0)
  if (stderr === undefined) throw new Error('ADB process did not expose collected stderr')
  return {
    argv: [...argv],
    ...classifyOutcome(outcome),
    stdout,
    stderr: stderr.text,
    stderrTruncated: stderr.lossy,
  }
}
