import { inflateRawSync } from 'node:zlib'

type EncodedValue = boolean | number | bigint | string | EncodedMap
type EncodedMap = Map<number, EncodedValue>

interface ZipEntry {
  name: string
  data: Buffer
}

interface DecodedWindow {
  name: string
  roots: ResolvedMap[]
  properties: ResolvedMap
}

interface ResolvedMap extends Map<string, ResolvedValue> {}
type ResolvedValue = boolean | number | bigint | string | ResolvedMap

/** Result of decoding `cmd window dump-visible-window-views`. */
export interface VisibleWindowHierarchy {
  xml: string
  truncated: boolean
  windows: number
  nodes: number
}

class BinaryReader {
  offset = 0

  constructor(private readonly data: Buffer) {}

  get remaining(): number {
    return this.data.byteLength - this.offset
  }

  private take(bytes: number): number {
    if (!Number.isInteger(bytes) || bytes < 0 || bytes > this.remaining) {
      throw new Error(`truncated encoded view hierarchy at byte ${this.offset}`)
    }
    const start = this.offset
    this.offset += bytes
    return start
  }

  readValue(): EncodedValue {
    const signatureOffset = this.take(1)
    const signature = this.data[signatureOffset]
    switch (signature) {
      case 0x5a: return this.data[this.take(1)] !== 0 // Z
      case 0x42: return this.data.readInt8(this.take(1)) // B
      case 0x53: return this.data.readInt16BE(this.take(2)) // S
      case 0x49: return this.data.readInt32BE(this.take(4)) // I
      case 0x4a: return this.data.readBigInt64BE(this.take(8)) // J
      case 0x46: return this.data.readFloatBE(this.take(4)) // F
      case 0x44: return this.data.readDoubleBE(this.take(8)) // D
      case 0x52: { // R
        const length = this.data.readInt16BE(this.take(2))
        if (length < 0) throw new Error(`negative encoded string length at byte ${this.offset - 2}`)
        return this.data.toString('utf8', this.take(length), this.offset)
      }
      case 0x4d: return this.readMap() // M
      default: throw new Error(`unexpected encoded view signature 0x${signature?.toString(16) ?? '??'} at byte ${signatureOffset}`)
    }
  }

  private readMap(): EncodedMap {
    const result: EncodedMap = new Map()
    while (true) {
      const key = this.readValue()
      if (typeof key !== 'number' || !Number.isInteger(key)) throw new Error('encoded view map key is not a short integer')
      if (key === 0) return result
      result.set(key, this.readValue())
    }
  }
}

function findEndOfCentralDirectory(zip: Buffer): number {
  const earliest = Math.max(0, zip.byteLength - 65_557)
  for (let offset = zip.byteLength - 22; offset >= earliest; offset -= 1) {
    if (zip.readUInt32LE(offset) === 0x06054b50) return offset
  }
  throw new Error('visible-window dump is not a supported ZIP archive')
}

function unzip(zipData: Uint8Array, maxExpandedBytes: number): ZipEntry[] {
  const zip = Buffer.from(zipData)
  if (zip.byteLength < 22) throw new Error('visible-window dump is too short to be a ZIP archive')
  const eocd = findEndOfCentralDirectory(zip)
  const disk = zip.readUInt16LE(eocd + 4)
  const centralDisk = zip.readUInt16LE(eocd + 6)
  const entriesOnDisk = zip.readUInt16LE(eocd + 8)
  const entryCount = zip.readUInt16LE(eocd + 10)
  const centralSize = zip.readUInt32LE(eocd + 12)
  const centralOffset = zip.readUInt32LE(eocd + 16)
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) throw new Error('multi-disk visible-window ZIP archives are unsupported')
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error('ZIP64 visible-window dumps are unsupported')
  if (centralOffset + centralSize > eocd) throw new Error('visible-window ZIP central directory is out of bounds')

  const entries: ZipEntry[] = []
  let expanded = 0
  let offset = centralOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > zip.byteLength || zip.readUInt32LE(offset) !== 0x02014b50) throw new Error('invalid visible-window ZIP central directory entry')
    const flags = zip.readUInt16LE(offset + 8)
    const method = zip.readUInt16LE(offset + 10)
    const compressedSize = zip.readUInt32LE(offset + 20)
    const uncompressedSize = zip.readUInt32LE(offset + 24)
    const nameLength = zip.readUInt16LE(offset + 28)
    const extraLength = zip.readUInt16LE(offset + 30)
    const commentLength = zip.readUInt16LE(offset + 32)
    const localOffset = zip.readUInt32LE(offset + 42)
    const next = offset + 46 + nameLength + extraLength + commentLength
    if (next > zip.byteLength) throw new Error('truncated visible-window ZIP central directory')
    const name = zip.toString((flags & 0x0800) === 0 ? 'latin1' : 'utf8', offset + 46, offset + 46 + nameLength)
    offset = next
    if (name.endsWith('/')) continue
    if ((flags & 0x0001) !== 0) throw new Error('encrypted visible-window ZIP entries are unsupported')
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) throw new Error('ZIP64 visible-window entries are unsupported')
    // A visible window can disappear or fail to answer while WindowManager is
    // collecting the dump. Android still emits a valid, empty ZIP entry for it.
    if (uncompressedSize === 0) continue
    if (expanded + uncompressedSize > maxExpandedBytes) throw new Error(`decoded visible-window hierarchy exceeds the ${maxExpandedBytes}-byte limit`)
    if (localOffset + 30 > zip.byteLength || zip.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('invalid visible-window ZIP local header')
    const localNameLength = zip.readUInt16LE(localOffset + 26)
    const localExtraLength = zip.readUInt16LE(localOffset + 28)
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength
    if (dataOffset + compressedSize > zip.byteLength) throw new Error('truncated visible-window ZIP entry')
    const compressed = zip.subarray(dataOffset, dataOffset + compressedSize)
    let data: Buffer
    if (method === 0) data = Buffer.from(compressed)
    else if (method === 8) data = inflateRawSync(compressed, { maxOutputLength: uncompressedSize })
    else throw new Error(`unsupported visible-window ZIP compression method ${method}`)
    if (data.byteLength !== uncompressedSize) throw new Error(`visible-window ZIP entry ${JSON.stringify(name)} has an invalid expanded size`)
    expanded += data.byteLength
    entries.push({ name, data })
  }
  return entries
}

function resolveMap(value: EncodedMap, names: ReadonlyMap<number, string>): ResolvedMap {
  const result: ResolvedMap = new Map()
  for (const [key, child] of value) {
    const name = names.get(key) ?? `property:${key}`
    result.set(name, child instanceof Map ? resolveMap(child, names) : child)
  }
  return result
}

function decodeWindow(entry: ZipEntry): DecodedWindow {
  const reader = new BinaryReader(entry.data)
  const values: EncodedValue[] = []
  while (reader.remaining > 0) values.push(reader.readValue())
  const maps = values.filter((value): value is EncodedMap => value instanceof Map)
  const propertyIndex = maps.pop()
  if (propertyIndex === undefined || maps.length === 0) throw new Error(`visible window ${JSON.stringify(entry.name)} contains no encoded view tree`)
  const names = new Map<number, string>()
  for (const [key, value] of propertyIndex) if (typeof value === 'string') names.set(key, value)

  const properties: ResolvedMap = new Map()
  const firstMap = values.findIndex(value => value instanceof Map)
  for (let index = 0; index >= 0 && index + 1 < firstMap; index += 2) {
    const key = values[index]
    const value = values[index + 1]
    if (typeof key === 'number' && value !== undefined && !(value instanceof Map)) {
      properties.set(names.get(key) ?? `property:${key}`, value)
    }
  }
  return { name: entry.name, roots: maps.map(map => resolveMap(map, names)), properties }
}

function xmlEscape(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '\ufffd')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function primitive(value: ResolvedValue | undefined): string | undefined {
  if (value === undefined || value instanceof Map) return undefined
  return typeof value === 'bigint' ? value.toString() : String(value)
}

function numeric(map: ResolvedMap, key: string): number {
  const value = map.get(key)
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function flattenProperties(map: ResolvedMap, prefix = ''): Array<[string, string]> {
  const result: Array<[string, string]> = []
  for (const [name, value] of map) {
    if (name.startsWith('meta:__') || name === 'theme') continue
    const qualified = prefix.length === 0 ? name : `${prefix}.${name}`
    if (value instanceof Map) result.push(...flattenProperties(value, qualified))
    else {
      const text = primitive(value)
      if (text !== undefined && isUsefulProperty(qualified, text)) result.push([qualified, text.slice(0, 4096)])
    }
  }
  return result
}

function isUsefulProperty(name: string, value: string): boolean {
  if (/^(?:id|layout:(?:left|right|top|bottom|width|height)|scrolling:scroll[XY])$/u.test(name)) return true
  if (/(?:text|contentDescription|hint|error|clickable|enabled|visibility|focus|selected|checked|checkable|editable|activated|pressed|translation[XY]|labelFor)/iu.test(name)) {
    return value !== ''
  }
  return false
}

interface RenderState {
  nodes: number
  maxNodes: number
  truncated: boolean
  truncationMarkerEmitted: boolean
}

function renderNode(map: ResolvedMap, parentX: number, parentY: number, parentScrollX: number, parentScrollY: number, state: RenderState): string {
  if (state.nodes >= state.maxNodes) {
    state.truncated = true
    if (state.truncationMarkerEmitted) return ''
    state.truncationMarkerEmitted = true
    return '<truncated reason="adb-dsh-plugin-node-limit"/>'
  }
  state.nodes += 1
  const left = parentX - parentScrollX + numeric(map, 'layout:left') + numeric(map, 'drawing:translationX')
  const top = parentY - parentScrollY + numeric(map, 'layout:top') + numeric(map, 'drawing:translationY')
  const width = numeric(map, 'layout:width')
  const height = numeric(map, 'layout:height')
  const attributes: Array<[string, string | undefined]> = [
    ['class', primitive(map.get('meta:__name__'))],
    ['resource-id', primitive(map.get('id'))],
    ['bounds', `[${Math.round(left)},${Math.round(top)}][${Math.round(left + width)},${Math.round(top + height)}]`],
  ]
  const properties = flattenProperties(map)
  const body = properties.map(([name, value]) => `<property name="${xmlEscape(name)}" value="${xmlEscape(value)}"/>`).join('')
  const childCount = numeric(map, 'meta:__childCount__')
  let children = ''
  for (let index = 0; index < childCount; index += 1) {
    const child = map.get(`meta:__child__${index}`)
    if (child instanceof Map) children += renderNode(child, left, top, numeric(map, 'scrolling:scrollX'), numeric(map, 'scrolling:scrollY'), state)
  }
  const renderedAttributes = attributes
    .filter((item): item is [string, string] => item[1] !== undefined && item[1] !== '')
    .map(([name, value]) => ` ${name}="${xmlEscape(value)}"`)
    .join('')
  return `<node${renderedAttributes}>${body}${children}</node>`
}

/** Decode Android's encoded visible-window ZIP into compact model-readable XML. */
export function decodeVisibleWindowHierarchy(zipData: Uint8Array, maxOutputBytes: number): VisibleWindowHierarchy {
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1) throw new Error('maxOutputBytes must be a positive integer')
  const windows = unzip(zipData, maxOutputBytes).map(decodeWindow)
  if (windows.length === 0) throw new Error('visible-window dump ZIP contains no window entries')
  let maxNodes = 5000
  let lastState: RenderState = { nodes: 0, maxNodes, truncated: false, truncationMarkerEmitted: false }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const state: RenderState = { nodes: 0, maxNodes, truncated: maxNodes < 5000, truncationMarkerEmitted: false }
    const rendered = windows.map(window => {
      const windowLeft = numeric(window.properties, 'window:left')
      const windowTop = numeric(window.properties, 'window:top')
      const roots = window.roots.map(root => renderNode(root, windowLeft, windowTop, 0, 0, state)).join('')
      return `<window name="${xmlEscape(window.name)}" left="${windowLeft}" top="${windowTop}">${roots}</window>`
    }).join('')
    const xml = `<?xml version="1.0" encoding="UTF-8"?><hierarchy source="window-manager-view-debug"${state.truncated ? ' truncated="true"' : ''}>${rendered}</hierarchy>`
    const outputBytes = Buffer.byteLength(xml)
    if (outputBytes <= maxOutputBytes) return { xml, truncated: state.truncated, windows: windows.length, nodes: state.nodes }
    lastState = state
    const estimated = Math.floor(maxNodes * (maxOutputBytes / outputBytes) * 0.8)
    const nextMaxNodes = Math.max(windows.length, Math.min(maxNodes - 1, estimated))
    if (nextMaxNodes >= maxNodes) break
    maxNodes = nextMaxNodes
  }
  const summary = windows.map(window => `<window name="${xmlEscape(window.name)}" omitted="adb-dsh-plugin-output-limit"/>`).join('')
  const xml = `<?xml version="1.0" encoding="UTF-8"?><hierarchy source="window-manager-view-debug" truncated="true">${summary}</hierarchy>`
  if (Buffer.byteLength(xml) > maxOutputBytes) throw new Error(`rendered visible-window hierarchy exceeds the ${maxOutputBytes}-byte limit`)
  return { xml, truncated: true, windows: windows.length, nodes: lastState.nodes }
}
