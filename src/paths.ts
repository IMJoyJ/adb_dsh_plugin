import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
}

/** Resolve a model-supplied host path and optionally confine it to the session workspace. */
export async function resolveHostPath(
  input: string,
  workspace: string,
  access: 'read' | 'write',
  restrictToWorkspace: boolean,
): Promise<string> {
  if (input.trim().length === 0 || input.includes('\0')) throw new Error('host path must be a non-empty path without NUL bytes')
  const resolved = resolve(workspace, input)
  if (!restrictToWorkspace) return resolved

  const canonicalWorkspace = await realpath(workspace)
  let checkTarget: string
  if (access === 'read') {
    checkTarget = await realpath(resolved)
  } else {
    try {
      await lstat(resolved)
      checkTarget = await realpath(resolved)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      checkTarget = await realpath(dirname(resolved))
    }
  }
  if (!isInside(canonicalWorkspace, checkTarget)) {
    throw new Error(`host path is outside the session workspace: ${input}`)
  }
  return resolved
}
