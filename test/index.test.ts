import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'

describe('entry point', () => {
  it('fails the step cleanly when a required input is missing', () => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('INPUT_') && !key.startsWith('GITHUB_')))
    const result = spawnSync(process.execPath, ['src/index.ts'], { env: { ...env, 'INPUT_MAX-TARGETS': '100' }, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stdout, /^::error::Input required and not supplied: token$/m)
    assert.equal(result.stderr, '')
  })
})
