/** One row from `adb devices -l`. */
export interface AdbDevice {
  serial: string
  state: string
  usb?: string
  product?: string
  model?: string
  device?: string
  transportId?: string
}

/** Parse the stable tabular output produced by `adb devices -l`. */
export function parseAdbDevices(output: string): AdbDevice[] {
  const devices: AdbDevice[] = []
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (line.length === 0 || line === 'List of devices attached' || line.startsWith('* daemon')) continue

    const firstSpace = line.search(/\s/u)
    if (firstSpace < 1) continue
    const serial = line.slice(0, firstSpace)
    const rest = line.slice(firstSpace).trim()
    const metadataStart = rest.search(/(?:^|\s)(?:usb|product|model|device|transport_id):/u)
    const state = (metadataStart < 0 ? rest : rest.slice(0, metadataStart)).trim()
    if (state.length === 0) continue

    const metadata = Object.fromEntries(
      [...rest.matchAll(/(?:^|\s)(usb|product|model|device|transport_id):([^\s]+)/gu)]
        .map(match => [match[1] as string, match[2] as string]),
    )
    devices.push({
      serial,
      state,
      ...(metadata.usb === undefined ? {} : { usb: metadata.usb }),
      ...(metadata.product === undefined ? {} : { product: metadata.product }),
      ...(metadata.model === undefined ? {} : { model: metadata.model }),
      ...(metadata.device === undefined ? {} : { device: metadata.device }),
      ...(metadata.transport_id === undefined ? {} : { transportId: metadata.transport_id }),
    })
  }
  return devices
}

/** Parse Android's `[property]: [value]` getprop format. */
export function parseGetProp(output: string): Readonly<Record<string, string>> {
  const properties: Record<string, string> = {}
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\[([^\]]+)\]: \[(.*)\]$/u.exec(line.trim())
    if (match?.[1] !== undefined && match[2] !== undefined) properties[match[1]] = match[2]
  }
  return properties
}

/** Extract the XML document from uiautomator's optional progress text. */
export function extractUiHierarchy(output: string): string | undefined {
  const declaration = output.indexOf('<?xml')
  const hierarchy = output.indexOf('<hierarchy')
  const start = declaration >= 0 ? declaration : hierarchy
  if (start < 0) return undefined
  const end = output.lastIndexOf('</hierarchy>')
  if (end < start) return undefined
  return output.slice(start, end + '</hierarchy>'.length).trim()
}

/** Keep at most the last N physical text lines while preserving a trailing newline. */
export function takeLastTextLines(output: string, maxLines: number): { text: string; truncated: boolean } {
  if (!Number.isInteger(maxLines) || maxLines < 1) throw new Error('maxLines must be a positive integer')
  const trailingNewline = /\r?\n$/u.test(output)
  const lines = output.split(/\r?\n/u)
  if (trailingNewline) lines.pop()
  if (lines.length <= maxLines) return { text: output, truncated: false }
  return {
    text: `${lines.slice(-maxLines).join('\n')}${trailingNewline ? '\n' : ''}`,
    truncated: true,
  }
}
