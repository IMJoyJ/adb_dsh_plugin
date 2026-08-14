import assert from 'node:assert/strict'
import test from 'node:test'
import { extractUiHierarchy, parseAdbDevices, parseGetProp, takeLastTextLines } from '../src/parsers.js'

test('parseAdbDevices keeps states and long-form metadata', () => {
  const devices = parseAdbDevices(`List of devices attached
emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1
R58M1234               unauthorized usb:1-2 transport_id:2
blocked                no permissions (missing udev rules) transport_id:3
`)
  assert.deepEqual(devices, [
    {
      serial: 'emulator-5554',
      state: 'device',
      product: 'sdk_gphone64_arm64',
      model: 'sdk_gphone64_arm64',
      device: 'emu64a',
      transportId: '1',
    },
    { serial: 'R58M1234', state: 'unauthorized', usb: '1-2', transportId: '2' },
    { serial: 'blocked', state: 'no permissions (missing udev rules)', transportId: '3' },
  ])
})

test('parseGetProp extracts bracketed Android properties', () => {
  assert.deepEqual(parseGetProp('[ro.product.model]: [Pixel 9]\n[ro.build.version.sdk]: [35]\nnoise'), {
    'ro.product.model': 'Pixel 9',
    'ro.build.version.sdk': '35',
  })
})

test('extractUiHierarchy ignores uiautomator progress text', () => {
  const xml = '<?xml version="1.0"?><hierarchy rotation="0"><node text="Settings" /></hierarchy>'
  assert.equal(extractUiHierarchy(`UI dump started\n${xml}\nUI hierchary dumped`), xml)
  assert.equal(extractUiHierarchy('UI dump failed'), undefined)
})

test('takeLastTextLines enforces a physical line cap', () => {
  assert.deepEqual(takeLastTextLines('one\ntwo\nthree\nfour\n', 2), {
    text: 'three\nfour\n',
    truncated: true,
  })
  assert.deepEqual(takeLastTextLines('one\r\ntwo', 2), {
    text: 'one\r\ntwo',
    truncated: false,
  })
})
