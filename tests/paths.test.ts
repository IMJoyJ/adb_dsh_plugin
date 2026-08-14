import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveHostPath } from '../src/paths.js'

test('resolveHostPath accepts workspace paths and rejects lexical escapes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'adb-dsh-paths-'))
  await writeFile(join(root, 'inside.txt'), 'ok')
  await mkdir(join(root, 'out'))
  assert.equal(await resolveHostPath('inside.txt', root, 'read', true), join(root, 'inside.txt'))
  assert.equal(await resolveHostPath('out/new.txt', root, 'write', true), join(root, 'out/new.txt'))
  await assert.rejects(resolveHostPath('../outside.txt', root, 'write', true), /outside the session workspace/u)
})

test('resolveHostPath rejects symlinks that escape the workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'adb-dsh-links-'))
  const outside = await mkdtemp(join(tmpdir(), 'adb-dsh-outside-'))
  await writeFile(join(outside, 'secret.txt'), 'secret')
  await symlink(outside, join(root, 'link'))
  await assert.rejects(resolveHostPath('link/secret.txt', root, 'read', true), /outside the session workspace/u)
  await assert.rejects(resolveHostPath('link/new.txt', root, 'write', true), /outside the session workspace/u)
})
