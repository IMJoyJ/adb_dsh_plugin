import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { registerAdbTools } from './tools.js'
import type { ResolvedConfig } from './tools.js'

export const name = 'adb-dsh-plugin'
export const inject = ['tools', 'subprocess']

/** User-configurable ADB tool policy and process limits. */
export interface Config {
  adbPath?: string
  defaultSerial?: string
  allowedSerials?: string[]
  commandTimeoutMs?: number
  transferTimeoutMs?: number
  maxOutputBytes?: number
  maxScreenshotBytes?: number
  processGraceMs?: number
  enableShell?: boolean
  enableDeviceControl?: boolean
  enableFileTransfer?: boolean
  enableAppManagement?: boolean
  enableDestructiveActions?: boolean
  enableScreenshots?: boolean
  enableUiHierarchy?: boolean
  restrictHostPathsToWorkspace?: boolean
}

/** Cordis configuration schema; every deployment-varying choice is patchable. */
export const Config: z<Config> = z.object({
  adbPath: z.string().default('adb'),
  defaultSerial: z.string(),
  allowedSerials: z.array(z.string()).default([]),
  commandTimeoutMs: z.number().default(30_000),
  transferTimeoutMs: z.number().default(180_000),
  maxOutputBytes: z.number().default(1_048_576),
  maxScreenshotBytes: z.number().default(16_777_216),
  processGraceMs: z.number().default(1_000),
  enableShell: z.boolean().default(false),
  enableDeviceControl: z.boolean().default(true),
  enableFileTransfer: z.boolean().default(true),
  enableAppManagement: z.boolean().default(true),
  enableDestructiveActions: z.boolean().default(false),
  enableScreenshots: z.boolean().default(true),
  enableUiHierarchy: z.boolean().default(true),
  restrictHostPathsToWorkspace: z.boolean().default(true),
})

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`adb-dsh-plugin: ${name} must be a positive integer`)
}

/** Validate configuration and register the enabled ADB tools. */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  if (resolved.adbPath.trim().length === 0 || resolved.adbPath.includes('\0')) {
    throw new Error('adb-dsh-plugin: adbPath must be non-empty and contain no NUL bytes')
  }
  assertPositiveInteger('commandTimeoutMs', resolved.commandTimeoutMs)
  assertPositiveInteger('transferTimeoutMs', resolved.transferTimeoutMs)
  assertPositiveInteger('maxOutputBytes', resolved.maxOutputBytes)
  assertPositiveInteger('maxScreenshotBytes', resolved.maxScreenshotBytes)
  assertPositiveInteger('processGraceMs', resolved.processGraceMs)
  if (resolved.defaultSerial !== undefined && resolved.defaultSerial.trim().length === 0) {
    throw new Error('adb-dsh-plugin: defaultSerial must be non-empty when configured')
  }
  if (new Set(resolved.allowedSerials).size !== resolved.allowedSerials.length) {
    throw new Error('adb-dsh-plugin: allowedSerials must not contain duplicates')
  }
  registerAdbTools(ctx, resolved)
}

export default { name, inject, Config, apply }
