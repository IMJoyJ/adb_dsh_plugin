/** One package returned by `pm list packages`. Numeric values remain strings to avoid precision loss. */
export interface InstalledPackage {
  packageName: string
  apkPath?: string
  versionCode?: string
  installer?: string
  uid?: string
}

/** One entry returned by Android's legacy `service list` command. */
export interface BinderService {
  index: number
  name: string
  descriptor?: string
}

export interface PermissionState {
  name: string
  scope: 'install' | 'runtime'
  granted: boolean
  flags: string[]
  userId?: number
}

export interface AppSummary {
  versionName?: string
  versionCode?: string
  minSdk?: string
  targetSdk?: string
  appId?: string
  codePath?: string
  dataDir?: string
  primaryCpuAbi?: string
  secondaryCpuAbi?: string
  firstInstallTime?: string
  lastUpdateTime?: string
  installerPackageName?: string
}

export interface AppInspection {
  summary: AppSummary
  requestedPermissions: string[]
  permissionStates: PermissionState[]
  components: {
    activities: string[]
    services: string[]
    receivers: string[]
    providers: string[]
  }
  disabledComponents: string[]
  enabledComponents: string[]
}

/** Parse `pm list packages -f -i -U --show-versioncode` and its filtered variants. */
export function parseInstalledPackages(output: string): InstalledPackage[] {
  const packages: InstalledPackage[] = []
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line.startsWith('package:')) continue

    const rest = line.slice('package:'.length)
    const whitespace = rest.search(/\s/u)
    const identity = whitespace < 0 ? rest : rest.slice(0, whitespace)
    const metadata = whitespace < 0 ? '' : rest.slice(whitespace + 1)
    const separator = identity.lastIndexOf('=')
    const packageName = separator < 0 ? identity : identity.slice(separator + 1)
    if (packageName.length === 0) continue

    const versionCode = /(?:^|\s)versionCode:([^\s]+)/u.exec(metadata)?.[1]
    const installer = /(?:^|\s)installer=([^\s]+)/u.exec(metadata)?.[1]
    const uid = /(?:^|\s)uid:([^\s]+)/u.exec(metadata)?.[1]
    packages.push({
      packageName,
      ...(separator < 0 ? {} : { apkPath: identity.slice(0, separator) }),
      ...(versionCode === undefined ? {} : { versionCode }),
      ...(installer === undefined || installer === 'null' ? {} : { installer }),
      ...(uid === undefined ? {} : { uid }),
    })
  }
  return packages
}

/** Parse the stable indexed output of Android's `service list`. */
export function parseBinderServices(output: string): BinderService[] {
  const services: BinderService[] = []
  for (const rawLine of output.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(.+?):\s*(?:\[(.*)\])?\s*$/u.exec(rawLine)
    if (match?.[1] === undefined || match[2] === undefined) continue
    const descriptor = match[3]?.trim()
    services.push({
      index: Number.parseInt(match[1], 10),
      name: match[2].trim(),
      ...(descriptor === undefined || descriptor.length === 0 ? {} : { descriptor }),
    })
  }
  return services
}

/** Parse `dumpsys -l`, which contains a header followed by one service name per line. */
export function parseDumpsysServices(output: string): string[] {
  return [...new Set(output.split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line.length > 0 && line !== 'Currently running services:'))]
}

/** Parse each `package:/...apk` row from `pm path`. */
export function parsePackagePaths(output: string): string[] {
  return output.split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line.startsWith('package:'))
    .map(line => line.slice('package:'.length))
    .filter(Boolean)
}

function indentOf(line: string): number {
  return /^\s*/u.exec(line)?.[0].length ?? 0
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function firstValue(output: string, key: string): string | undefined {
  const match = new RegExp(`^\\s*${escapeRegExp(key)}=(.*)$`, 'mu').exec(output)?.[1]?.trim()
  return match === undefined || match === 'null' || match.length === 0 ? undefined : match
}

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)]
}

type ComponentType = keyof AppInspection['components']

const COMPONENT_HEADINGS: Readonly<Record<string, ComponentType>> = {
  'activities:': 'activities',
  'services:': 'services',
  'receivers:': 'receivers',
  'providers:': 'providers',
  'Activity Resolver Table:': 'activities',
  'Service Resolver Table:': 'services',
  'Receiver Resolver Table:': 'receivers',
  'Provider Resolver Table:': 'providers',
}

function parseComponents(output: string, packageName: string): AppInspection['components'] {
  const collected: Record<ComponentType, string[]> = {
    activities: [],
    services: [],
    receivers: [],
    providers: [],
  }
  const componentPattern = new RegExp(`${escapeRegExp(packageName)}/[A-Za-z0-9_.$]+`, 'gu')
  let active: ComponentType | undefined
  let headingIndent = -1

  for (const line of output.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed === 'Hidden system packages:') break
    const heading = COMPONENT_HEADINGS[trimmed]
    if (heading !== undefined) {
      active = heading
      headingIndent = indentOf(line)
      continue
    }
    if (active === undefined || trimmed.length === 0) continue
    if (indentOf(line) <= headingIndent) {
      active = undefined
      continue
    }
    for (const match of line.matchAll(componentPattern)) collected[active].push(match[0])
  }

  return {
    activities: unique(collected.activities),
    services: unique(collected.services),
    receivers: unique(collected.receivers),
    providers: unique(collected.providers),
  }
}

function parseComponentOverrides(output: string, packageName: string, heading: string): string[] {
  const values: string[] = []
  let active = false
  let headingIndent = -1
  for (const line of output.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed === 'Hidden system packages:') break
    if (trimmed === heading) {
      active = true
      headingIndent = indentOf(line)
      continue
    }
    if (!active || trimmed.length === 0) continue
    if (indentOf(line) <= headingIndent) {
      active = false
      continue
    }
    if (/^[A-Za-z0-9_.$/]+$/u.test(trimmed)) {
      if (trimmed.includes('/')) values.push(trimmed)
      else if (trimmed.startsWith('.')) values.push(`${packageName}/${trimmed}`)
      else if (trimmed.startsWith(`${packageName}.`)) values.push(`${packageName}/.${trimmed.slice(packageName.length + 1)}`)
      else values.push(`${packageName}/${trimmed}`)
    }
  }
  return unique(values)
}

function parsePermissionFlags(raw: string | undefined): string[] {
  if (raw === undefined) return []
  return raw.split(/[|,]/u).map(value => value.trim()).filter(Boolean)
}

function parsePermissions(output: string): Pick<AppInspection, 'requestedPermissions' | 'permissionStates'> {
  const requestedPermissions: string[] = []
  const permissionStates: PermissionState[] = []
  let section: 'requested' | 'install' | 'runtime' | undefined
  let sectionIndent = -1
  let currentUserId: number | undefined

  for (const line of output.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed === 'Hidden system packages:') break
    const user = /^User (\d+):/u.exec(trimmed)?.[1]
    if (user !== undefined) currentUserId = Number.parseInt(user, 10)

    const nextSection = trimmed === 'requested permissions:'
      ? 'requested'
      : trimmed === 'install permissions:'
        ? 'install'
        : trimmed === 'runtime permissions:'
          ? 'runtime'
          : undefined
    if (nextSection !== undefined) {
      section = nextSection
      sectionIndent = indentOf(line)
      continue
    }
    if (section === undefined || trimmed.length === 0) continue
    if (indentOf(line) <= sectionIndent) {
      section = undefined
      continue
    }

    if (section === 'requested') {
      const permission = /^([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)$/u.exec(trimmed)?.[1]
      if (permission !== undefined) requestedPermissions.push(permission)
      continue
    }

    const match = /^([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+):\s+granted=(true|false)(?:,\s+flags=\[([^\]]*)\])?(?:,\s+userId=(\d+))?/u.exec(trimmed)
    if (match?.[1] === undefined || match[2] === undefined) continue
    const explicitUser = match[4] === undefined ? undefined : Number.parseInt(match[4], 10)
    const userId = section === 'runtime' ? currentUserId : explicitUser
    permissionStates.push({
      name: match[1],
      scope: section,
      granted: match[2] === 'true',
      flags: parsePermissionFlags(match[3]),
      ...(userId === undefined ? {} : { userId }),
    })
  }

  return {
    requestedPermissions: unique(requestedPermissions),
    permissionStates,
  }
}

/** Turn a package-manager dump into the app fields most useful to a model. */
export function parseAppInspection(output: string, packageName: string): AppInspection {
  const version = /^\s*versionCode=([^\s]+)(?:\s+minSdk=([^\s]+))?(?:\s+targetSdk=([^\s]+))?/mu.exec(output)
  const summary: AppSummary = {}
  if (version?.[1] !== undefined) summary.versionCode = version[1]
  if (version?.[2] !== undefined) summary.minSdk = version[2]
  if (version?.[3] !== undefined) summary.targetSdk = version[3]
  const appId = firstValue(output, 'appId') ?? firstValue(output, 'userId')
  if (appId !== undefined) summary.appId = appId
  const scalarFields = [
    ['versionName', 'versionName'],
    ['codePath', 'codePath'],
    ['dataDir', 'dataDir'],
    ['primaryCpuAbi', 'primaryCpuAbi'],
    ['secondaryCpuAbi', 'secondaryCpuAbi'],
    ['firstInstallTime', 'firstInstallTime'],
    ['lastUpdateTime', 'lastUpdateTime'],
    ['installerPackageName', 'installerPackageName'],
  ] as const
  for (const [field, dumpKey] of scalarFields) {
    const value = firstValue(output, dumpKey)
    if (value !== undefined) summary[field] = value
  }
  const permissions = parsePermissions(output)
  return {
    summary,
    ...permissions,
    components: parseComponents(output, packageName),
    disabledComponents: parseComponentOverrides(output, packageName, 'disabledComponents:'),
    enabledComponents: parseComponentOverrides(output, packageName, 'enabledComponents:'),
  }
}
