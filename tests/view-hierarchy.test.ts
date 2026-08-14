import assert from 'node:assert/strict'
import test from 'node:test'
import { deflateRawSync } from 'node:zlib'
import { decodeVisibleWindowHierarchy } from '../src/view-hierarchy.js'

function concat(...parts: Array<Buffer | string>): Buffer {
  return Buffer.concat(parts.map(part => typeof part === 'string' ? Buffer.from(part) : part))
}

function short(value: number): Buffer {
  const bytes = Buffer.alloc(3)
  bytes[0] = 0x53
  bytes.writeInt16BE(value, 1)
  return bytes
}

function integer(value: number): Buffer {
  const bytes = Buffer.alloc(5)
  bytes[0] = 0x49
  bytes.writeInt32BE(value, 1)
  return bytes
}

function bool(value: boolean): Buffer {
  return Buffer.from([0x5a, value ? 1 : 0])
}

function string(value: string): Buffer {
  const text = Buffer.from(value)
  const length = Buffer.alloc(2)
  length.writeInt16BE(text.byteLength)
  return concat('R', length, text)
}

function map(entries: Array<[number, Buffer]>): Buffer {
  return concat('M', ...entries.flatMap(([key, value]) => [short(key), value]), short(0))
}

function encodedWindow(): Buffer {
  const names = [
    'window:left', 'window:top', 'meta:__name__', 'meta:__hash__', 'id',
    'layout:left', 'layout:top', 'layout:width', 'layout:height', 'misc:clickable',
    'text:text', 'meta:__childCount__', '__name__',
  ]
  const root = map([
    [3, string('android.widget.TextView')],
    [4, integer(123)],
    [5, string('com.example:id/title')],
    [6, integer(5)],
    [7, integer(6)],
    [8, integer(100)],
    [9, integer(50)],
    [10, bool(true)],
    [11, string('Hello & <Android>')],
    [12, short(0)],
  ])
  const index = map([
    [13, string('propertyIndex')],
    ...names.map((name, offset): [number, Buffer] => [offset + 1, string(name)]),
  ])
  return concat(short(1), integer(10), short(2), integer(20), root, index)
}

function zipEntry(name: string, source: Buffer): Buffer {
  const nameBytes = Buffer.from(name)
  const compressed = deflateRawSync(source)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0x0800, 6)
  local.writeUInt16LE(8, 8)
  local.writeUInt32LE(compressed.byteLength, 18)
  local.writeUInt32LE(source.byteLength, 22)
  local.writeUInt16LE(nameBytes.byteLength, 26)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0x0800, 8)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(compressed.byteLength, 20)
  central.writeUInt32LE(source.byteLength, 24)
  central.writeUInt16LE(nameBytes.byteLength, 28)
  central.writeUInt32LE(0, 42)

  const centralOffset = local.byteLength + nameBytes.byteLength + compressed.byteLength
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(central.byteLength + nameBytes.byteLength, 12)
  eocd.writeUInt32LE(centralOffset, 16)
  return concat(local, nameBytes, compressed, central, nameBytes, eocd)
}

test('decodeVisibleWindowHierarchy decodes Android ViewHierarchyEncoder ZIP data', () => {
  const result = decodeVisibleWindowHierarchy(zipEntry('Launcher & Home', encodedWindow()), 64 * 1024)
  assert.equal(result.windows, 1)
  assert.equal(result.nodes, 1)
  assert.equal(result.truncated, false)
  assert.match(result.xml, /<hierarchy source="window-manager-view-debug">/u)
  assert.match(result.xml, /<window name="Launcher &amp; Home" left="10" top="20">/u)
  assert.match(result.xml, /class="android\.widget\.TextView"/u)
  assert.match(result.xml, /resource-id="com\.example:id\/title"/u)
  assert.match(result.xml, /bounds="\[15,26\]\[115,76\]"/u)
  assert.match(result.xml, /name="text:text" value="Hello &amp; &lt;Android&gt;"/u)
})

test('decodeVisibleWindowHierarchy rejects expanded output over the configured limit', () => {
  assert.throws(
    () => decodeVisibleWindowHierarchy(zipEntry('window', encodedWindow()), 16),
    /exceeds the 16-byte limit/u,
  )
})

test('decodeVisibleWindowHierarchy keeps valid bounded XML when rendering expands past the limit', () => {
  const encoded = encodedWindow()
  const result = decodeVisibleWindowHierarchy(zipEntry('window', encoded), encoded.byteLength + 64)
  assert.equal(result.truncated, true)
  assert.ok(Buffer.byteLength(result.xml) <= encoded.byteLength + 64)
  assert.match(result.xml, /<hierarchy source="window-manager-view-debug" truncated="true">/u)
  assert.match(result.xml, /<\/hierarchy>$/u)
})
