/**
 * Opt-in functional test against one authorized ADB device. It exercises the
 * real Cordis tool registry, Harness subprocess provider, attachment store,
 * and adb-dsh-plugin definitions without calling an external model.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { CallId } from '@deepseek-ai/dsh-llm'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as AdbPlugin from '../src/index.js'

const execFileAsync = promisify(execFile)
const workspace = resolve(fileURLToPath(new URL('..', import.meta.url)))
const testRoot = join(workspace, '.adb-dsh-device-test')
const hostSource = join(testRoot, 'host-source.txt')
const hostPulled = join(testRoot, 'host-pulled.txt')
const remotePath = '/data/local/tmp/adb_dsh_plugin_function_test.txt'
const signal = new AbortController().signal
let callNumber = 0

class ImageCapableLlm extends Service {
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }

  async resolveModelInfo(): Promise<{ inputModalities: ['text', 'image'] }> {
    return { inputModalities: ['text', 'image'] }
  }
}

function textContent(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
}

async function main(): Promise<void> {
  await rm(testRoot, { recursive: true, force: true })
  await mkdir(testRoot, { recursive: true })
  await writeFile(hostSource, 'adb-dsh-plugin device round-trip\n', 'utf8')

  const ctx = new Context()
  const fibers = []
  try {
    fibers.push(await ctx.plugin(SystemPrompt))
    fibers.push(await ctx.plugin(ToolRuntime, { mode: 'native' }))
    fibers.push(await ctx.plugin(LocalSubprocessRuntime))
    fibers.push(await ctx.plugin(ImageCapableLlm))
    fibers.push(await ctx.plugin(LocalAttachmentStore, { dshHome: join(testRoot, 'dsh-home') }))
    fibers.push(await ctx.plugin(AdbPlugin, {
      adbPath: 'adb',
      allowedSerials: [],
      commandTimeoutMs: 30_000,
      transferTimeoutMs: 180_000,
      maxOutputBytes: 1_048_576,
      maxScreenshotBytes: 16_777_216,
      processGraceMs: 1_000,
      enableShell: false,
      enableDeviceControl: true,
      enableFileTransfer: true,
      enableAppManagement: true,
      enableDestructiveActions: false,
      enableScreenshots: true,
      enableUiHierarchy: true,
      restrictHostPathsToWorkspace: true,
    }))

    const fakeAgent = {
      options: { provider: 'functional-test', model: 'image-capable' },
      session: {
        header: { cwd: workspace },
        requestHeader: () => undefined,
      },
    }
    const call = async (name: string, args: unknown) => {
      const result = await ctx.tools.execute({
        signal,
        callId: CallId(`adb-device-test-${++callNumber}`),
        name,
        arguments: args,
        agent: fakeAgent as never,
      })
      if (result.isError) throw new Error(`${name}: ${textContent(result)}`)
      return result.value as Record<string, unknown> | unknown[]
    }

    const devices = await call('adb_devices', {}) as Array<{ serial: string; state: string }>
    const online = devices.filter(device => device.state === 'device')
    assert.equal(online.length, 1, `expected exactly one online device, received ${JSON.stringify(devices)}`)
    const serial = online[0]!.serial

    const info = await call('adb_device_info', { serial }) as Record<string, unknown>
    assert.equal(info.serial, serial)
    assert.equal(typeof info.model, 'string')

    const screenshot = await call('adb_screenshot', { serial }) as {
      image: { bytes: number; width: number; height: number }
    }
    assert.ok(screenshot.image.bytes > 0)
    assert.ok(screenshot.image.width > 0)
    assert.ok(screenshot.image.height > 0)

    let hierarchy: { xml: string; truncated: boolean; source: string } | undefined
    let hierarchyError: string | undefined
    try {
      hierarchy = await call('adb_ui_hierarchy', { serial }) as { xml: string; truncated: boolean; source: string }
      assert.match(hierarchy.xml, /<hierarchy/u)
      assert.match(hierarchy.xml, /<node/u)
    } catch (error: unknown) {
      hierarchyError = error instanceof Error ? error.message : String(error)
    }

    const input = await call('adb_input', { serial, action: 'keyevent', keyCode: 'KEYCODE_UNKNOWN' }) as { exitCode: number }
    assert.equal(input.exitCode, 0)

    const packages = await call('adb_packages', { serial, scope: 'all', filter: 'com.android.settings' }) as {
      packages: Array<{ packageName: string; apkPath?: string }>
      truncated: boolean
    }
    assert.ok(packages.packages.some(item => item.packageName === 'com.android.settings'))

    const appInfo = await call('adb_app_info', { serial, packageName: 'com.android.settings' }) as {
      requestedPermissions: string[]
      components: { activities: string[]; services: string[]; receivers: string[]; providers: string[] }
      apkPaths: string[]
      truncated: boolean
    }
    assert.ok(appInfo.apkPaths.length > 0)
    assert.ok(appInfo.requestedPermissions.length > 0)
    assert.ok(appInfo.components.activities.length > 0)

    const services = await call('adb_system_services', { serial, kind: 'both' }) as {
      binderServices: Array<{ name: string }>
      dumpsysServices: string[]
      truncated: boolean
    }
    assert.ok(services.binderServices.length > 0)
    assert.ok(services.dumpsysServices.includes('package'))

    const packageService = await call('adb_service_dump', { serial, service: 'package' }) as {
      stdout: string
      exitCode: number
      stdoutTruncated: boolean
    }
    assert.equal(packageService.exitCode, 0)
    assert.ok(packageService.stdout.length > 0)

    const logcat = await call('adb_logcat', { serial, lines: 20 }) as { stdout: string; exitCode: number; stdoutTruncated: boolean }
    assert.equal(logcat.exitCode, 0)
    assert.ok(logcat.stdout.split(/\r?\n/u).filter((_, index, rows) => index < rows.length - 1 || rows[index] !== '').length <= 20)

    const pushed = await call('adb_file', {
      serial,
      operation: 'push',
      hostPath: '.adb-dsh-device-test/host-source.txt',
      devicePath: remotePath,
    }) as { exitCode: number }
    assert.equal(pushed.exitCode, 0)
    const pulled = await call('adb_file', {
      serial,
      operation: 'pull',
      hostPath: '.adb-dsh-device-test/host-pulled.txt',
      devicePath: remotePath,
    }) as { exitCode: number }
    assert.equal(pulled.exitCode, 0)
    assert.equal(await readFile(hostPulled, 'utf8'), await readFile(hostSource, 'utf8'))

    process.stdout.write(`${JSON.stringify({
      serial,
      model: info.model,
      androidVersion: info.androidVersion,
      uiHierarchy: hierarchy === undefined
        ? { ok: false, error: hierarchyError }
        : { ok: true, source: hierarchy.source, truncated: hierarchy.truncated, bytes: Buffer.byteLength(hierarchy.xml) },
      screenshot: screenshot.image,
      packageInspection: {
        listed: packages.packages.length,
        apkPaths: appInfo.apkPaths.length,
        requestedPermissions: appInfo.requestedPermissions.length,
        components: Object.fromEntries(Object.entries(appInfo.components).map(([kind, entries]) => [kind, entries.length])),
        truncated: packages.truncated || appInfo.truncated,
      },
      systemServices: {
        binder: services.binderServices.length,
        dumpsys: services.dumpsysServices.length,
        packageDumpBytes: Buffer.byteLength(packageService.stdout),
        truncated: services.truncated || packageService.stdoutTruncated,
      },
      logcatBytes: Buffer.byteLength(logcat.stdout),
      logcatPhysicalLines: logcat.stdout.split(/\r?\n/u).filter((_, index, rows) => index < rows.length - 1 || rows[index] !== '').length,
      logcatTruncated: logcat.stdoutTruncated,
      inputKeyevent: 'ok',
      fileRoundTrip: 'ok',
    }, null, 2)}\n`)
    if (hierarchyError !== undefined) throw new Error(hierarchyError)
  } finally {
    await execFileAsync('adb', ['shell', 'rm', '-f', remotePath]).catch(() => {})
    for (const fiber of fibers.reverse()) await fiber.dispose().catch(() => {})
    await rm(testRoot, { recursive: true, force: true })
  }
}

await main()
