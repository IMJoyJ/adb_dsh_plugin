import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { extractUiHierarchy, parseAdbDevices, parseGetProp, takeLastTextLines } from './parsers.js'
import type { AdbDevice } from './parsers.js'
import { resolveHostPath } from './paths.js'
import { runAdbBinary, runAdbText } from './runner.js'
import type { AdbRunnerConfig, AdbTextResult } from './runner.js'
import { decodeVisibleWindowHierarchy } from './view-hierarchy.js'

/** Fully resolved runtime configuration passed to the tool registrations. */
export interface ResolvedConfig extends AdbRunnerConfig {
  defaultSerial?: string
  allowedSerials: string[]
  commandTimeoutMs: number
  transferTimeoutMs: number
  maxScreenshotBytes: number
  enableShell: boolean
  enableDeviceControl: boolean
  enableFileTransfer: boolean
  enableAppManagement: boolean
  enableDestructiveActions: boolean
  enableScreenshots: boolean
  enableUiHierarchy: boolean
  restrictHostPathsToWorkspace: boolean
}

interface CommandValue {
  serial: string
  argv: string[]
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
}

const COMMAND_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    serial: { type: 'string', required: true },
    argv: { type: 'array', items: { type: 'string' }, required: true },
    exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
    signal: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    stdout: { type: 'string', required: true },
    stderr: { type: 'string', required: true },
    stdoutTruncated: { type: 'boolean', required: true },
    stderrTruncated: { type: 'boolean', required: true },
  },
} as const

const SERIAL_PARAMETER = {
  type: 'string',
  description: 'ADB device serial. Omit to use the configured default or auto-select the only online allowed device.',
} as const

function workdir(exec: ToolExecution): string {
  return exec.agent?.session.header.cwd ?? process.cwd()
}

function serialArgv(serial: string): string[] {
  return ['-s', serial]
}

function validateSerial(serial: string): void {
  if (!/^[^\s\0]+$/u.test(serial)) throw new Error('ADB serial must be non-empty and contain no whitespace or NUL bytes')
}

function isAllowed(config: ResolvedConfig, serial: string): boolean {
  return config.allowedSerials.length === 0 || config.allowedSerials.includes(serial)
}

function ensureAllowed(config: ResolvedConfig, serial: string): void {
  validateSerial(serial)
  if (!isAllowed(config, serial)) throw new Error(`ADB device ${JSON.stringify(serial)} is not listed in allowedSerials`)
}

function failureText(result: AdbTextResult): string {
  const details = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n')
  const status = result.signal === null ? `exit code ${result.exitCode ?? 'unknown'}` : `signal ${result.signal}`
  return `${status}${details.length === 0 ? '' : `: ${details}`}`
}

function assertSuccess(result: AdbTextResult, operation: string): void {
  if (result.exitCode === 0 && result.signal === null) return
  throw new Error(`${operation} failed (${failureText(result)})`)
}

async function listDevices(
  ctx: Context,
  config: ResolvedConfig,
  cwd: string,
  signal: AbortSignal,
): Promise<AdbDevice[]> {
  const result = await runAdbText(ctx, config, cwd, ['devices', '-l'], signal)
  assertSuccess(result, 'adb devices')
  const devices = parseAdbDevices(result.stdout)
  return config.allowedSerials.length === 0 ? devices : devices.filter(device => isAllowed(config, device.serial))
}

async function selectSerial(
  ctx: Context,
  config: ResolvedConfig,
  cwd: string,
  requested: string | undefined,
  signal: AbortSignal,
): Promise<string> {
  const chosen = requested?.trim() || config.defaultSerial?.trim()
  if (chosen !== undefined && chosen.length > 0) {
    ensureAllowed(config, chosen)
    return chosen
  }
  const online = (await listDevices(ctx, config, cwd, signal)).filter(device => device.state === 'device')
  if (online.length === 1 && online[0] !== undefined) return online[0].serial
  if (online.length === 0) throw new Error('no online allowed ADB device is connected')
  throw new Error(`multiple online ADB devices are connected; pass serial explicitly: ${online.map(device => device.serial).join(', ')}`)
}

async function runForDevice(
  ctx: Context,
  config: ResolvedConfig,
  exec: ToolExecution,
  requestedSerial: string | undefined,
  argv: readonly string[],
): Promise<{ serial: string; result: AdbTextResult }> {
  const cwd = workdir(exec)
  const serial = await selectSerial(ctx, config, cwd, requestedSerial, exec.signal)
  const result = await runAdbText(ctx, config, cwd, [...serialArgv(serial), ...argv], exec.signal)
  return { serial, result }
}

function commandValue(serial: string, result: AdbTextResult): CommandValue {
  return {
    serial,
    argv: result.argv,
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
  }
}

function renderCommand(value: CommandValue): string {
  const sections: string[] = []
  if (value.stdout.length > 0) sections.push(value.stdout)
  if (value.stderr.length > 0) sections.push(`[stderr]\n${value.stderr}`)
  if (value.stdoutTruncated || value.stderrTruncated) sections.push('[output truncated by adb-dsh-plugin]')
  if (value.signal !== null) sections.push(`[killed by signal: ${value.signal}]`)
  else if (value.exitCode !== 0) sections.push(`[exit code: ${value.exitCode ?? 'unknown'}]`)
  if (sections.length === 0) return '(no output)'
  let rendered = ''
  for (const section of sections) {
    if (rendered.length > 0 && !rendered.endsWith('\n')) rendered += '\n'
    rendered += section
  }
  return rendered
}

function validateCoordinate(name: string, value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
  return value
}

function validatePackageName(value: string | undefined): string {
  if (value === undefined || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/u.test(value)) {
    throw new Error('packageName must be a valid Android application id')
  }
  return value
}

function registerDevicesTool(ctx: Context, config: ResolvedConfig): void {
  ctx.tools.register(defineTool({
    name: 'adb_devices',
    description: 'List ADB devices visible to this deployment, including serial, connection state, model, and transport metadata. Devices outside allowedSerials are omitted.',
    parameters: {},
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            serial: { type: 'string', required: true },
            state: { type: 'string', required: true },
            usb: { type: 'string' },
            product: { type: 'string' },
            model: { type: 'string' },
            device: { type: 'string' },
            transportId: { type: 'string' },
          },
        },
      },
      render: (_args, devices) => [{
        type: 'text',
        text: devices.length === 0
          ? 'No allowed ADB devices are connected.'
          : devices.map(device => `${device.serial}\t${device.state}${device.model === undefined ? '' : `\tmodel:${device.model}`}`).join('\n'),
      }],
    },
    timeoutMs: config.commandTimeoutMs,
    isConcurrencySafe: () => true,
    execute: (_args, exec) => listDevices(ctx, config, workdir(exec), exec.signal),
    presentCall: () => ({ card: 'generic', title: 'List ADB devices', kind: 'read' }),
  }))
}

function registerDeviceInfoTool(ctx: Context, config: ResolvedConfig): void {
  ctx.tools.register(defineTool({
    name: 'adb_device_info',
    description: 'Read identity, Android build, display, and battery information from one connected Android device.',
    parameters: { serial: SERIAL_PARAMETER },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          serial: { type: 'string', required: true },
          manufacturer: { type: 'string', required: true },
          model: { type: 'string', required: true },
          product: { type: 'string', required: true },
          androidVersion: { type: 'string', required: true },
          sdk: { type: 'string', required: true },
          abi: { type: 'string', required: true },
          buildId: { type: 'string', required: true },
          displaySize: { type: 'string', required: true },
          displayDensity: { type: 'string', required: true },
          battery: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    timeoutMs: config.commandTimeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const cwd = workdir(exec)
      const serial = await selectSerial(ctx, config, cwd, args.serial, exec.signal)
      const prefix = serialArgv(serial)
      const [propertiesResult, sizeResult, densityResult, batteryResult] = await Promise.all([
        runAdbText(ctx, config, cwd, [...prefix, 'shell', 'getprop'], exec.signal),
        runAdbText(ctx, config, cwd, [...prefix, 'shell', 'wm', 'size'], exec.signal),
        runAdbText(ctx, config, cwd, [...prefix, 'shell', 'wm', 'density'], exec.signal),
        runAdbText(ctx, config, cwd, [...prefix, 'shell', 'dumpsys', 'battery'], exec.signal),
      ])
      assertSuccess(propertiesResult, 'read Android properties')
      const properties = parseGetProp(propertiesResult.stdout)
      return {
        serial,
        manufacturer: properties['ro.product.manufacturer'] ?? '',
        model: properties['ro.product.model'] ?? '',
        product: properties['ro.product.name'] ?? '',
        androidVersion: properties['ro.build.version.release'] ?? '',
        sdk: properties['ro.build.version.sdk'] ?? '',
        abi: properties['ro.product.cpu.abi'] ?? '',
        buildId: properties['ro.build.id'] ?? '',
        displaySize: sizeResult.stdout.trim(),
        displayDensity: densityResult.stdout.trim(),
        battery: batteryResult.stdout.trim(),
      }
    },
    presentCall: args => ({ card: 'generic', title: `Inspect Android device${args.serial === undefined ? '' : ` ${args.serial}`}`, kind: 'read' }),
  }))
}

function registerShellTool(ctx: Context, config: ResolvedConfig): void {
  if (!config.enableShell) return
  ctx.tools.register(defineTool({
    name: 'adb_shell',
    description: 'Run an arbitrary command through `adb shell sh -c` on the selected device. This has the full authority of the device ADB shell user; prefer a narrower adb_* tool when one exists.',
    parameters: {
      serial: SERIAL_PARAMETER,
      command: { type: 'string', required: true, description: 'Device-side shell command. It is never interpreted by the host shell.' },
    },
    output: { schema: COMMAND_OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: renderCommand(value) }] },
    timeoutMs: config.commandTimeoutMs,
    async execute(args, exec) {
      if (args.command.trim().length === 0 || args.command.includes('\0')) throw new Error('command must be non-empty and contain no NUL bytes')
      const { serial, result } = await runForDevice(ctx, config, exec, args.serial, ['shell', 'sh', '-c', args.command])
      return commandValue(serial, result)
    },
    presentCall: args => ({ card: 'terminal', title: `adb shell ${args.command}` }),
  }))
}

function inputArgv(args: {
  action: 'tap' | 'swipe' | 'text' | 'keyevent'
  x?: number
  y?: number
  x2?: number
  y2?: number
  durationMs?: number
  text?: string
  keyCode?: string
}): string[] {
  if (args.action === 'tap') return ['shell', 'input', 'tap', String(validateCoordinate('x', args.x)), String(validateCoordinate('y', args.y))]
  if (args.action === 'swipe') {
    const duration = args.durationMs ?? 300
    if (!Number.isInteger(duration) || duration < 0 || duration > 60_000) throw new Error('durationMs must be an integer from 0 through 60000')
    return [
      'shell', 'input', 'swipe',
      String(validateCoordinate('x', args.x)), String(validateCoordinate('y', args.y)),
      String(validateCoordinate('x2', args.x2)), String(validateCoordinate('y2', args.y2)), String(duration),
    ]
  }
  if (args.action === 'text') {
    if (args.text === undefined || args.text.length === 0) throw new Error('text is required for the text action')
    if (!/^[A-Za-z0-9 _.,@:/+\-=]+$/u.test(args.text)) {
      throw new Error('adb input text accepts only safe ASCII letters, digits, spaces, and _.,@:/+-= through this tool')
    }
    return ['shell', 'input', 'text', args.text.replaceAll(' ', '%s')]
  }
  if (args.keyCode === undefined || !/^(?:KEYCODE_)?[A-Z0-9_]+$/u.test(args.keyCode)) {
    throw new Error('keyCode must be an Android KEYCODE name or numeric code')
  }
  return ['shell', 'input', 'keyevent', args.keyCode]
}

function registerInputTool(ctx: Context, config: ResolvedConfig): void {
  if (!config.enableDeviceControl) return
  ctx.tools.register(defineTool({
    name: 'adb_input',
    description: 'Control the selected Android device with a tap, swipe, safe ASCII text entry, or Android key event. Use adb_screenshot or adb_ui_hierarchy to inspect the screen before choosing coordinates.',
    parameters: {
      serial: SERIAL_PARAMETER,
      action: { type: 'string', enum: ['tap', 'swipe', 'text', 'keyevent'], required: true },
      x: { type: 'integer', description: 'Tap/swipe start X coordinate.' },
      y: { type: 'integer', description: 'Tap/swipe start Y coordinate.' },
      x2: { type: 'integer', description: 'Swipe end X coordinate.' },
      y2: { type: 'integer', description: 'Swipe end Y coordinate.' },
      durationMs: { type: 'integer', description: 'Swipe duration in milliseconds; defaults to 300.' },
      text: { type: 'string', description: 'Safe ASCII text for the text action.' },
      keyCode: { type: 'string', description: 'Android key code such as KEYCODE_HOME, BACK, or 4.' },
    },
    output: { schema: COMMAND_OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: renderCommand(value) }] },
    timeoutMs: config.commandTimeoutMs,
    async execute(args, exec) {
      const { serial, result } = await runForDevice(ctx, config, exec, args.serial, inputArgv(args))
      return commandValue(serial, result)
    },
    presentCall: args => ({ card: 'generic', title: `ADB ${args.action}`, kind: 'execute', rawInput: args }),
  }))
}

async function assertImageCapableRoute(ctx: Context, exec: ToolExecution): Promise<void> {
  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new Error('cannot return an ADB screenshot: the current model route could not be resolved')
  }
  const active = await llm.resolveModelInfo(provider, model, exec.signal)
  if (active.inputModalities === undefined || !active.inputModalities.includes('image')) {
    throw new Error(`cannot return an ADB screenshot: model ${JSON.stringify(model)} does not declare image input; use adb_ui_hierarchy or switch to an image-capable model`)
  }
}

interface ScreenshotValue {
  serial: string
  image: {
    attachmentId: string
    mediaType: 'image/png'
    bytes: number
    width: number
    height: number
    name?: string
  }
}

function screenshotContent(value: ScreenshotValue): ContentBlock[] {
  return [
    { type: 'text', text: `ADB screenshot from ${value.serial}: ${value.image.width}x${value.image.height}, ${value.image.bytes} bytes` },
    { type: 'image', attachment: value.image as ImageAttachmentRef },
  ]
}

function registerScreenshotTool(ctx: Context, config: ResolvedConfig): void {
  if (!config.enableScreenshots) return
  ctx.tools.register(defineTool({
    name: 'adb_screenshot',
    description: 'Capture the selected Android device display and return the PNG image to an image-capable model. For a text-only model, use adb_ui_hierarchy instead.',
    parameters: { serial: SERIAL_PARAMETER },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          serial: { type: 'string', required: true },
          image: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', const: 'image/png', required: true },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
              name: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value) => screenshotContent(value),
    },
    timeoutMs: config.commandTimeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      await assertImageCapableRoute(ctx, exec)
      const attachments = ctx.get('attachments')
      if (attachments === undefined) throw new Error('cannot return an ADB screenshot: no attachment service is mounted')
      if (!attachments.imageLimits.mediaTypes.includes('image/png')) throw new Error('this deployment does not accept PNG attachments')

      const cwd = workdir(exec)
      const serial = await selectSerial(ctx, config, cwd, args.serial, exec.signal)
      const maxBytes = Math.min(config.maxScreenshotBytes, attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)
      const result = await runAdbBinary(ctx, config, cwd, [...serialArgv(serial), 'exec-out', 'screencap', '-p'], exec.signal, maxBytes)
      if (result.exitCode !== 0 || result.signal !== null) {
        throw new Error(`capture Android screenshot failed (${result.signal ?? `exit code ${result.exitCode ?? 'unknown'}`}${result.stderr.trim().length === 0 ? '' : `: ${result.stderr.trim()}`})`)
      }
      const bytes = Buffer.from(result.stdout)
      const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      if (bytes.byteLength < pngSignature.byteLength || !bytes.subarray(0, pngSignature.byteLength).equals(pngSignature)) {
        throw new Error('adb screencap returned data that is not a PNG image')
      }
      const ref = await attachments.saveImage({ data: bytes, mediaType: 'image/png', name: `adb-${serial}-screenshot.png` })
      const value: ScreenshotValue = {
        serial,
        image: {
          attachmentId: ref.attachmentId,
          mediaType: 'image/png',
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...(ref.name === undefined ? {} : { name: ref.name }),
        },
      }
      if (exec.parent !== undefined) {
        exec.deferContext(createUserMessage({ content: screenshotContent(value), source: { kind: 'plugin', plugin: 'adb-dsh-plugin' } }))
      }
      return value
    },
    presentCall: () => ({ card: 'generic', title: 'Capture Android screenshot', kind: 'read' }),
  }))
}

function registerUiHierarchyTool(ctx: Context, config: ResolvedConfig): void {
  if (!config.enableUiHierarchy) return
  ctx.tools.register(defineTool({
    name: 'adb_ui_hierarchy',
    description: 'Dump the current Android UI hierarchy as XML, including visible text, content descriptions, resource ids, enabled/clickable state, and screen bounds. Prefers the accessibility hierarchy and falls back to Android visible-window View data when uiautomator is unavailable. Works with text-only models.',
    parameters: { serial: SERIAL_PARAMETER },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          serial: { type: 'string', required: true },
          xml: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
          source: { type: 'string', enum: ['uiautomator', 'window-manager-view-debug'], required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `[adb_ui_hierarchy source=${value.source} truncated=${String(value.truncated)}]`,
          value.xml,
          ...(value.truncated ? ['[UI hierarchy truncated by adb-dsh-plugin]'] : []),
        ].join('\n'),
      }],
    },
    timeoutMs: config.commandTimeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const cwd = workdir(exec)
      const serial = await selectSerial(ctx, config, cwd, args.serial, exec.signal)
      const prefix = serialArgv(serial)
      let result = await runAdbText(ctx, config, cwd, [...prefix, 'exec-out', 'uiautomator', 'dump', '/dev/tty'], exec.signal)
      let xml = extractUiHierarchy(result.stdout)
      const diagnostics = [result.stdout.trim(), result.stderr.trim()].filter(Boolean)
      if (xml === undefined) {
        const remotePath = '/sdcard/adb_dsh_window_dump.xml'
        const dump = await runAdbText(ctx, config, cwd, [...prefix, 'shell', 'uiautomator', 'dump', remotePath], exec.signal)
        assertSuccess(dump, 'dump Android UI hierarchy')
        diagnostics.push(dump.stdout.trim(), dump.stderr.trim())
        try {
          result = await runAdbText(ctx, config, cwd, [...prefix, 'exec-out', 'cat', remotePath], exec.signal)
          diagnostics.push(result.stdout.trim(), result.stderr.trim())
          if (result.exitCode === 0 && result.signal === null) xml = extractUiHierarchy(result.stdout)
        } finally {
          await runAdbText(ctx, config, cwd, [...prefix, 'shell', 'rm', '-f', remotePath], exec.signal).catch(() => {})
        }
      }
      if (xml !== undefined) return { serial, xml, truncated: result.stdoutTruncated, source: 'uiautomator' as const }

      const visible = await runAdbBinary(
        ctx,
        config,
        cwd,
        [...prefix, 'exec-out', 'cmd', 'window', 'dump-visible-window-views'],
        exec.signal,
        config.maxOutputBytes,
      )
      if (visible.exitCode === 0 && visible.signal === null) {
        try {
          const hierarchy = decodeVisibleWindowHierarchy(visible.stdout, config.maxOutputBytes)
          return { serial, xml: hierarchy.xml, truncated: hierarchy.truncated, source: 'window-manager-view-debug' as const }
        } catch (error: unknown) {
          diagnostics.push(error instanceof Error ? error.message : String(error))
        }
      } else {
        diagnostics.push(`visible-window fallback failed (${visible.signal ?? `exit code ${visible.exitCode ?? 'unknown'}`}${visible.stderr.trim().length === 0 ? '' : `: ${visible.stderr.trim()}`})`)
      }
      if (xml === undefined) {
        const detail = [...new Set(diagnostics.filter(Boolean))].join('\n')
        throw new Error(`Android returned no readable UI hierarchy${detail.length === 0 ? '' : `:\n${detail}`}`)
      }
      return { serial, xml, truncated: result.stdoutTruncated, source: 'uiautomator' as const }
    },
    presentCall: () => ({ card: 'generic', title: 'Inspect Android UI hierarchy', kind: 'read' }),
  }))
}

function registerFileTool(ctx: Context, config: ResolvedConfig): void {
  if (!config.enableFileTransfer) return
  ctx.tools.register(defineTool({
    name: 'adb_file',
    description: 'Push a host file/directory to an Android device or pull a device file/directory to the host. Host paths are confined to the current session workspace by default.',
    parameters: {
      serial: SERIAL_PARAMETER,
      operation: { type: 'string', enum: ['push', 'pull'], required: true },
      hostPath: { type: 'string', required: true, description: 'Host path, relative to the session workspace unless absolute.' },
      devicePath: { type: 'string', required: true, description: 'Absolute or shell-user-relative Android device path.' },
    },
    output: { schema: COMMAND_OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: renderCommand(value) }] },
    timeoutMs: config.transferTimeoutMs,
    async execute(args, exec) {
      if (args.devicePath.trim().length === 0 || args.devicePath.includes('\0')) throw new Error('devicePath must be non-empty and contain no NUL bytes')
      const cwd = workdir(exec)
      const hostPath = await resolveHostPath(args.hostPath, cwd, args.operation === 'push' ? 'read' : 'write', config.restrictHostPathsToWorkspace)
      const serial = await selectSerial(ctx, config, cwd, args.serial, exec.signal)
      const transfer = args.operation === 'push' ? ['push', hostPath, args.devicePath] : ['pull', args.devicePath, hostPath]
      const result = await runAdbText(ctx, config, cwd, [...serialArgv(serial), ...transfer], exec.signal)
      return commandValue(serial, result)
    },
    presentCall: args => ({
      card: 'generic',
      title: `${args.operation === 'push' ? 'Push to' : 'Pull from'} Android device`,
      kind: args.operation === 'push' ? 'execute' : 'fetch',
      rawInput: { hostPath: args.hostPath, devicePath: args.devicePath },
      locations: [{ path: args.hostPath }],
    }),
  }))
}

function registerAppTool(ctx: Context, config: ResolvedConfig): void {
  if (!config.enableAppManagement) return
  ctx.tools.register(defineTool({
    name: 'adb_app',
    description: 'List, install, launch, force-stop, clear, or uninstall Android applications. clear_data and uninstall require enableDestructiveActions. APK host paths are workspace-confined by default.',
    parameters: {
      serial: SERIAL_PARAMETER,
      action: { type: 'string', enum: ['list_packages', 'install', 'launch', 'force_stop', 'clear_data', 'uninstall'], required: true },
      packageName: { type: 'string', description: 'Android application id; required except for list_packages and install.' },
      activity: { type: 'string', description: 'Optional activity class for launch. Without it, the launcher activity is used.' },
      apkPath: { type: 'string', description: 'Host APK path for install.' },
      thirdPartyOnly: { type: 'boolean', description: 'For list_packages, include only third-party packages.' },
      replace: { type: 'boolean', description: 'For install, replace an existing app; defaults to true.' },
      grantPermissions: { type: 'boolean', description: 'For install, grant runtime permissions.' },
      allowDowngrade: { type: 'boolean', description: 'For install, allow version-code downgrade.' },
      keepData: { type: 'boolean', description: 'For uninstall, retain app data and cache.' },
    },
    output: { schema: COMMAND_OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: renderCommand(value) }] },
    timeoutMs: config.transferTimeoutMs,
    async execute(args, exec) {
      const cwd = workdir(exec)
      const serial = await selectSerial(ctx, config, cwd, args.serial, exec.signal)
      let argv: string[]
      if (args.action === 'list_packages') {
        argv = ['shell', 'pm', 'list', 'packages', ...(args.thirdPartyOnly === true ? ['-3'] : [])]
      } else if (args.action === 'install') {
        if (args.apkPath === undefined) throw new Error('apkPath is required for install')
        const apkPath = await resolveHostPath(args.apkPath, cwd, 'read', config.restrictHostPathsToWorkspace)
        argv = [
          'install',
          ...(args.replace === false ? [] : ['-r']),
          ...(args.grantPermissions === true ? ['-g'] : []),
          ...(args.allowDowngrade === true ? ['-d'] : []),
          apkPath,
        ]
      } else {
        const packageName = validatePackageName(args.packageName)
        if ((args.action === 'clear_data' || args.action === 'uninstall') && !config.enableDestructiveActions) {
          throw new Error(`${args.action} is disabled; set enableDestructiveActions: true in the plugin config to allow it`)
        }
        if (args.action === 'launch') {
          if (args.activity === undefined) {
            argv = ['shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1']
          } else {
            if (!/^[A-Za-z0-9_.$]+$/u.test(args.activity)) throw new Error('activity contains unsupported characters')
            argv = ['shell', 'am', 'start', '-n', `${packageName}/${args.activity}`]
          }
        } else if (args.action === 'force_stop') {
          argv = ['shell', 'am', 'force-stop', packageName]
        } else if (args.action === 'clear_data') {
          argv = ['shell', 'pm', 'clear', packageName]
        } else {
          argv = ['uninstall', ...(args.keepData === true ? ['-k'] : []), packageName]
        }
      }
      const result = await runAdbText(ctx, config, cwd, [...serialArgv(serial), ...argv], exec.signal)
      return commandValue(serial, result)
    },
    presentCall: args => ({ card: 'generic', title: `ADB app: ${args.action}`, kind: args.action === 'list_packages' ? 'read' : 'execute', rawInput: args }),
  }))
}

function registerLogcatTool(ctx: Context, config: ResolvedConfig): void {
  ctx.tools.register(defineTool({
    name: 'adb_logcat',
    description: 'Read a bounded snapshot of recent Android logcat output. The lines parameter is enforced as a hard physical-line limit. Use filterSpecs such as "ActivityManager:I" and "*:S" to reduce noise.',
    parameters: {
      serial: SERIAL_PARAMETER,
      lines: { type: 'integer', description: 'Recent line count from 1 through 5000; defaults to 200.' },
      buffers: { type: 'array', items: { type: 'string', enum: ['main', 'system', 'radio', 'events', 'crash', 'all'] }, description: 'Optional log buffers.' },
      filterSpecs: { type: 'array', items: { type: 'string' }, description: 'Optional logcat filters, each passed as one argument.' },
    },
    output: { schema: COMMAND_OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: renderCommand(value) }] },
    timeoutMs: config.commandTimeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const lines = args.lines ?? 200
      if (!Number.isInteger(lines) || lines < 1 || lines > 5000) throw new Error('lines must be an integer from 1 through 5000')
      const filters = args.filterSpecs ?? []
      if (filters.some(value => value.length === 0 || value.includes('\0'))) throw new Error('filterSpecs entries must be non-empty and contain no NUL bytes')
      const bufferArgs = (args.buffers ?? []).flatMap(buffer => ['-b', buffer])
      const { serial, result } = await runForDevice(ctx, config, exec, args.serial, ['logcat', '-d', '-t', String(lines), ...bufferArgs, ...filters])
      const bounded = takeLastTextLines(result.stdout, lines)
      return commandValue(serial, {
        ...result,
        stdout: bounded.text,
        stdoutTruncated: result.stdoutTruncated || bounded.truncated,
      })
    },
    presentCall: () => ({ card: 'generic', title: 'Read Android logcat', kind: 'read' }),
  }))
}

/** Register every enabled ADB model tool. */
export function registerAdbTools(ctx: Context, config: ResolvedConfig): void {
  registerDevicesTool(ctx, config)
  registerDeviceInfoTool(ctx, config)
  registerShellTool(ctx, config)
  registerScreenshotTool(ctx, config)
  registerUiHierarchyTool(ctx, config)
  registerInputTool(ctx, config)
  registerAppTool(ctx, config)
  registerFileTool(ctx, config)
  registerLogcatTool(ctx, config)
}
