import assert from 'node:assert/strict'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.js'
import type { Config } from '../src/index.js'

const BASE_CONFIG = {
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
} satisfies Config

function registered(config: Config): string[] {
  const names: string[] = []
  const ctx = {
    tools: {
      register(definition: { name: string }) {
        names.push(definition.name)
        return () => {}
      },
    },
  } as unknown as Context
  apply(ctx, config)
  return names
}

test('apply registers the safe default tool set without arbitrary shell', () => {
  assert.deepEqual(registered(BASE_CONFIG), [
    'adb_devices',
    'adb_device_info',
    'adb_screenshot',
    'adb_ui_hierarchy',
    'adb_input',
    'adb_app',
    'adb_file',
    'adb_logcat',
  ])
})

test('apply gates optional tools through configuration', () => {
  const names = registered({
    ...BASE_CONFIG,
    enableShell: true,
    enableScreenshots: false,
    enableUiHierarchy: false,
    enableDeviceControl: false,
    enableAppManagement: false,
    enableFileTransfer: false,
  })
  assert.deepEqual(names, ['adb_devices', 'adb_device_info', 'adb_shell', 'adb_logcat'])
})

test('apply rejects unsafe numeric configuration', () => {
  assert.throws(() => registered({ ...BASE_CONFIG, maxOutputBytes: 0 }), /maxOutputBytes must be a positive integer/u)
})
