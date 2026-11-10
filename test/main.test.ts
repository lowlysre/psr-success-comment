import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test'
import { marker } from '../src/comment.ts'
import { logStatus } from '../src/format.ts'
import { gitIn, type Git } from '../src/git.ts'
import { readInputs, run, type Deps, type Inputs } from '../src/main.ts'
import { fakeGitHub, makeRepo, urlOf, type FakeGitHub, type TestRepo } from './helpers.ts'

// @actions/core caches the job summary path on first write, so the files live for the whole run.
const dir = mkdtempSync(join(tmpdir(), 'psr-'))
const outFile = join(dir, 'output')
const summaryFile = join(dir, 'summary.md')
process.env.GITHUB_OUTPUT = outFile
process.env.GITHUB_STEP_SUMMARY = summaryFile
let stdout: string

const realWrite = process.stdout.write.bind(process.stdout) as (...a: unknown[]) => boolean
// The test runner streams binary events over stdout, so only text from the action is captured.
const captureStdout = () =>
  mock.method(process.stdout, 'write', ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof chunk === 'string') {
      stdout += chunk
      return true
    }
    return realWrite(chunk, ...rest)
  }) as typeof process.stdout.write)

/** Parses the GITHUB_OUTPUT file, including the heredoc form used for values with special characters. */
function readOutputs(): Record<string, string> {
  const result: Record<string, string> = {}
  const lines = readFileSync(outFile, 'utf8').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const heredoc = /^([^=<]+)<<(.+)$/.exec(lines[i] ?? '')
    if (heredoc) {
      const end = lines.indexOf(heredoc[2] as string, i + 1)
      result[heredoc[1] as string] = lines.slice(i + 1, end).join('\n')
      i = end
    }
  }
  return result
}

let repo: TestRepo
let git: Git
let fake: FakeGitHub
const sha: Record<string, string> = {}

// main: a(v1.0.0) - b - c - d(v1.1.0), where b was merged by PR #10 and c touches pkg/.
before(() => {
  repo = makeRepo()
  git = gitIn(repo.dir)
  sha.a = repo.commit('chore: start')
  repo.tag('v1.0.0')
  sha.b = repo.commit('feat: add widgets (#10)')
  sha.c = repo.commit('fix: handle <empty> input\n\nCloses #2', 'pkg/fix.txt')
  sha.d = repo.commit('1.1.0')
  repo.tag('v1.1.0')
})

after(() => {
  repo.remove()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(async () => {
  writeFileSync(outFile, '')
  writeFileSync(summaryFile, '')
  process.exitCode = undefined
  stdout = ''
  fake = await fakeGitHub()
  fake.prs.set(10, { body: 'Adds widgets.\n\nFixes #1', merge: sha.b })
  fake.issues.add(1).add(2)
  fake.authors.set(10, 'octocat')
  fake.labels.set(1, ['bug'])
  fake.associated.set(sha.b as string, [10])
  captureStdout()
})

afterEach(async () => {
  mock.restoreAll()
  process.exitCode = undefined
  await fake.close()
})

const inputs = (over: Partial<Inputs> = {}): Inputs => ({
  tag: 'v1.1.0',
  version: '1.1.0',
  previousTag: '',
  releaseUrl: 'https://github.test/acme/widgets/releases/tag/v1.1.0',
  paths: [],
  comment: '',
  labels: ['released'],
  filters: { targets: 'all', skipLabels: [], skipAuthors: [] },
  token: 'test-token',
  dryRun: false,
  maxTargets: 100,
  summary: false,
  repository: 'acme/widgets',
  apiUrl: fake.url,
  graphqlUrl: `${fake.url}/graphql`,
  serverUrl: 'https://github.com',
  workspace: repo.dir,
  ...over
})
const deps = (over: Deps = {}): Deps => ({ git, gh: fake.gh, pause: () => Promise.resolve(), ...over })

describe('run', () => {
  it('comments on and labels the pull request and the issues it and the commits close', async () => {
    await run(inputs(), deps())
    assert.equal(process.exitCode, undefined)
    assert.deepEqual(readOutputs(), {
      'previous-tag': 'v1.0.0',
      commits: '3',
      'pull-requests': '[10]',
      issues: '[1,2]',
      commented: '[1,2,10]',
      skipped: '[]',
      failed: '[]',
      json: JSON.stringify([
        { number: 1, kind: 'issue', url: urlOf(1, false), author: '', labels: ['bug'], status: 'commented', commented: true },
        { number: 2, kind: 'issue', url: urlOf(2, false), author: '', labels: [], status: 'commented', commented: true },
        { number: 10, kind: 'pr', url: urlOf(10, true), author: 'octocat', labels: [], status: 'commented', commented: true }
      ])
    })
    for (const number of [1, 2, 10]) {
      assert.ok(fake.comments.get(number)?.[0]?.endsWith(marker('v1.1.0')))
      assert.ok(fake.labels.get(number)?.includes('released'))
    }
    assert.match(stdout, /Release.*v1\.1\.0.*since v1\.0\.0, 3 commits/)
    assert.ok(stdout.includes(logStatus('commented')))
  })

  it('is safe to re-run: nothing is commented twice', async () => {
    await run(inputs(), deps())
    writeFileSync(outFile, '')
    await run(inputs(), deps())
    assert.equal(process.exitCode, undefined)
    assert.equal(readOutputs().commented, '[]')
    assert.equal(readOutputs().skipped, '[1,2,10]')
    assert.equal(fake.comments.get(10)?.length, 1)
  })

  it('treats a release with no earlier tag as a first release', async () => {
    await run(inputs({ tag: 'v1.0.0', version: '1.0.0' }), deps())
    assert.equal(process.exitCode, undefined)
    assert.equal(readOutputs()['previous-tag'], '')
    assert.equal(readOutputs().commits, '1')
    assert.equal(readOutputs()['pull-requests'], '[]')
    assert.match(stdout, /first release, 1 commit\)/)
    assert.match(stdout, /No pull requests or issues to update\./)
  })

  it('uses an explicit previous tag, and makes no API call for an empty range', async () => {
    repo.git('tag', '--force', 'same', 'v1.1.0')
    await run(inputs({ previousTag: 'same' }), deps())
    assert.equal(process.exitCode, undefined)
    assert.equal(readOutputs()['previous-tag'], 'same')
    assert.equal(readOutputs().commits, '0')
    assert.equal(fake.calls.length, 0)
  })

  it('limits the release to commits touching the given paths', async () => {
    await run(inputs({ paths: ['pkg'] }), deps())
    assert.equal(readOutputs().commits, '1')
    assert.equal(readOutputs()['pull-requests'], '[]')
    assert.equal(readOutputs().issues, '[2]')
  })

  it('leaves out filtered targets, but still follows a filtered pull request to the issues it closes', async () => {
    await run(inputs({ filters: { targets: 'issues', skipLabels: ['bug'], skipAuthors: [] }, summary: true }), deps())
    assert.equal(process.exitCode, undefined)
    assert.equal(readOutputs().commented, '[2]')
    assert.equal(readOutputs().skipped, '[1,10]')
    assert.equal(fake.comments.has(1), false)
    assert.equal(fake.comments.has(10), false)
    assert.doesNotMatch(stdout, /::warning/)
    assert.match(stdout, /PR #10 .*\(targets is 'issues'\)/)
    assert.match(readFileSync(summaryFile, 'utf8'), /⚪ filtered<\/td><td>label 'bug'/)
  })

  it('counts filtered targets toward max-targets', async () => {
    await run(inputs({ maxTargets: 2, filters: { targets: 'issues', skipLabels: [], skipAuthors: [] } }), deps())
    assert.equal(process.exitCode, 1)
  })

  it('reports a dry run without writing', async () => {
    await run(inputs({ dryRun: true, summary: true }), deps())
    assert.equal(process.exitCode, undefined)
    assert.equal(fake.comments.size, 0)
    assert.deepEqual([...fake.labels], [[1, ['bug']]])
    assert.equal(readOutputs().commented, '[]')
    assert.match(stdout, /::notice title=psr-success-comment::Dry run: no comments or labels were written\./)
    assert.match(readFileSync(summaryFile, 'utf8'), /3 commits \(dry run\)\./)
    assert.match(readFileSync(summaryFile, 'utf8'), /🔵 would-comment/)
  })

  it('fails before writing anything when there are more targets than max-targets', async () => {
    await run(inputs({ maxTargets: 2 }), deps())
    assert.equal(process.exitCode, 1)
    assert.match(stdout, /::error::Found 3 pull requests and issues, more than 'max-targets' \(2\)\. Nothing was changed\./)
    assert.ok(fake.calls.every(call => call.path === '/graphql'))
    assert.equal(readFileSync(outFile, 'utf8'), '')
  })

  it('applies no limit when max-targets is 0', async () => {
    await run(inputs({ maxTargets: 0 }), deps())
    assert.equal(process.exitCode, undefined)
    assert.equal(readOutputs().commented, '[1,2,10]')
  })

  it('warns about a forbidden target without failing the step', async () => {
    fake.canned.set('POST /repos/acme/widgets/issues/10/comments', [
      { status: 403, body: { message: 'Resource not accessible by integration' } }
    ])
    await run(inputs(), deps())
    assert.equal(process.exitCode, undefined)
    assert.equal(readOutputs().skipped, '[10]')
    assert.match(stdout, /::warning title=Release comment skipped::Skipped PR #10 for v1\.1\.0: POST .* returned 403/)
  })

  it('fails the step after trying every target, and still publishes outputs', async () => {
    fake.canned.set('POST /repos/acme/widgets/issues/2/comments', [{ status: 422, body: { message: 'Validation Failed' } }])
    await run(inputs({ summary: true }), deps())
    assert.equal(process.exitCode, 1)
    assert.equal(readOutputs().failed, '[2]')
    assert.equal(readOutputs().commented, '[1,10]')
    assert.match(stdout, /::error title=Release comment failed::Could not update issue #2 for v1\.1\.0: .*422: Validation Failed/)
    assert.match(stdout, /::error::Failed to update #2\. Re-running is safe/)
    assert.match(readFileSync(summaryFile, 'utf8'), /🔴 failed/)
    assert.match(readFileSync(summaryFile, 'utf8'), /<th>Detail<\/th>.*<td>–<\/td>.*422: Validation Failed/s)
  })

  it('lists a target in commented when the comment was posted but the labels failed', async () => {
    fake.canned.set('POST /repos/acme/widgets/issues/2/labels', [{ status: 422, body: { message: 'Validation Failed' } }])
    await run(inputs(), deps())
    assert.equal(process.exitCode, 1)
    assert.equal(readOutputs().failed, '[2]')
    assert.equal(readOutputs().commented, '[1,2,10]')
    assert.match(stdout, /Failed to update #2\. Re-running is safe/)
  })

  it('writes a job summary when enabled and skips it when disabled', async () => {
    await run(inputs({ summary: true }), deps())
    const md = readFileSync(summaryFile, 'utf8')
    assert.match(
      md,
      /Release comments: <a href="https:\/\/github\.test\/acme\/widgets\/releases\/tag\/v1\.1\.0"><code>v1\.1\.0<\/code><\/a>/
    )
    assert.match(md, /Since <code>v1\.0\.0<\/code>, 3 commits\./)
    assert.match(md, /<a href="https:\/\/github\.test\/acme\/widgets\/pull\/10">PR #10<\/a>/)
    assert.match(md, /🟢 commented/)
    assert.doesNotMatch(md, /Detail|<td><\/tr>/)
    assert.doesNotMatch(md, /\u001b\[/)

    writeFileSync(summaryFile, '')
    await run(inputs({ tag: 'v1.0.0', version: '1.0.0', releaseUrl: '', summary: true }), deps())
    const first = readFileSync(summaryFile, 'utf8')
    assert.match(first, /Release comments: <code>v1\.0\.0<\/code>/)
    assert.match(first, /First release, 1 commit\./)
    assert.match(first, /No pull requests or issues to update\./)

    writeFileSync(summaryFile, '')
    await run(inputs(), deps())
    assert.equal(readFileSync(summaryFile, 'utf8'), '')
  })

  it('escapes values in the job summary', async () => {
    repo.git('tag', '--force', 'v&1.1.0', 'v1.1.0')
    fake.canned.set('POST /repos/acme/widgets/issues/1/comments', [{ status: 422, body: { message: '<img src=x onerror=alert(1)>' } }])
    await run(inputs({ tag: 'v&1.1.0', previousTag: 'v1.0.0', releaseUrl: 'https://x.test/"><script>', summary: true }), deps())
    const md = readFileSync(summaryFile, 'utf8')
    assert.doesNotMatch(md, /<img|<script|v&1/)
    assert.match(md, /<code>v&#38;1\.1\.0<\/code>/)
    assert.match(md, /&#60;img src=x onerror=alert\(1\)&#62;/)
  })

  it('fails on a shallow clone', async () => {
    const shallow: Git = args => (args.includes('--is-shallow-repository') ? Promise.resolve('true\n') : git(args))
    await run(inputs(), deps({ git: shallow }))
    assert.equal(process.exitCode, 1)
    assert.match(stdout, /::error::The checkout is a shallow clone.*fetch-depth: 0/)
  })

  it('fails when the tag or the previous tag is not in the checkout', async () => {
    await run(inputs({ tag: 'v9.9.9', version: '9.9.9' }), deps())
    assert.match(stdout, /::error::Tag 'v9\.9\.9' was not found in the checkout\./)
    stdout = ''
    await run(inputs({ previousTag: 'v0.0.1' }), deps())
    assert.match(stdout, /::error::Tag 'v0\.0\.1' was not found in the checkout\./)
    assert.equal(process.exitCode, 1)
    assert.equal(fake.calls.length, 0)
  })

  for (const repository of ['', 'acme', 'acme/widgets/extra', '/widgets']) {
    it(`rejects GITHUB_REPOSITORY ${JSON.stringify(repository)}`, async () => {
      await run(inputs({ repository }), deps())
      assert.equal(process.exitCode, 1)
      assert.match(stdout, /::error::GITHUB_REPOSITORY must be 'owner\/repo'/)
    })
  }

  it('reports an API failure while finding pull requests', async () => {
    fake.canned.set('POST /graphql', [{ status: 401, body: { message: 'Bad credentials' } }])
    await run(inputs(), deps())
    assert.equal(process.exitCode, 1)
    assert.match(stdout, /::error::POST \/graphql returned 401: Bad credentials/)
  })

  it('builds its own git and GitHub clients from the inputs', async () => {
    await run(inputs({ paths: ['pkg'], labels: [] }))
    assert.equal(process.exitCode, undefined)
    assert.equal(readOutputs().commented, '[2]')
    assert.equal(fake.calls[0]?.path, '/graphql')
  })
})

describe('readInputs', () => {
  const set = (values: Record<string, string>) => {
    for (const [key, value] of Object.entries(values)) process.env[`INPUT_${key}`] = value
  }
  const defaults = {
    TAG: 'v1.1.0',
    VERSION: '1.1.0',
    TOKEN: 'ghs_secret',
    LABELS: 'released',
    'MAX-TARGETS': '100',
    'DRY-RUN': 'false',
    SUMMARY: 'true'
  }

  beforeEach(() => set(defaults))
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (key.startsWith('INPUT_')) delete process.env[key]
  })

  it('reads the defaults declared in action.yml', () => {
    assert.deepEqual(readInputs({}), {
      tag: 'v1.1.0',
      version: '1.1.0',
      previousTag: '',
      releaseUrl: '',
      paths: [],
      comment: '',
      labels: ['released'],
      filters: { targets: 'all', skipLabels: [], skipAuthors: [] },
      token: 'ghs_secret',
      dryRun: false,
      maxTargets: 100,
      summary: true,
      repository: '',
      apiUrl: 'https://api.github.com',
      graphqlUrl: 'https://api.github.com/graphql',
      serverUrl: 'https://github.com',
      workspace: process.cwd()
    })
    assert.match(stdout, /::add-mask::ghs_secret/)
  })

  it('reads lists one per line, and the runner environment', () => {
    set({ PATHS: ' packages/a \r\n\npackages/b\n', LABELS: 'released\nshipped in 1.1.0', 'PREVIOUS-TAG': ' v1.0.0 ', 'DRY-RUN': 'true' })
    const read = readInputs({
      GITHUB_REPOSITORY: 'acme/widgets',
      GITHUB_API_URL: 'https://ghe.test/api/v3',
      GITHUB_GRAPHQL_URL: 'https://ghe.test/api/graphql',
      GITHUB_SERVER_URL: 'https://ghe.test',
      GITHUB_WORKSPACE: '/work'
    })
    assert.deepEqual(read.paths, ['packages/a', 'packages/b'])
    assert.deepEqual(read.labels, ['released', 'shipped in 1.1.0'])
    assert.equal(read.previousTag, 'v1.0.0')
    assert.equal(read.dryRun, true)
    assert.deepEqual(
      [read.repository, read.apiUrl, read.graphqlUrl, read.serverUrl, read.workspace],
      ['acme/widgets', 'https://ghe.test/api/v3', 'https://ghe.test/api/graphql', 'https://ghe.test', '/work']
    )
  })

  it('reads the filters', () => {
    set({ TARGETS: ' issues ', 'SKIP-LABELS': 'wontfix\nno release note', 'SKIP-AUTHORS': 'dependabot[bot]' })
    assert.deepEqual(readInputs({}).filters, {
      targets: 'issues',
      skipLabels: ['wontfix', 'no release note'],
      skipAuthors: ['dependabot[bot]']
    })
  })

  it('rejects an unknown targets value', () => {
    set({ TARGETS: 'prs' })
    assert.throws(() => readInputs({}), /Invalid 'targets' 'prs': it must be all, pull-requests, issues\./)
  })

  it('adds no labels when the labels input is empty', () => {
    set({ LABELS: '' })
    assert.deepEqual(readInputs({}).labels, [])
  })

  it('requires tag, version, and token', () => {
    for (const key of ['TAG', 'VERSION', 'TOKEN']) {
      set({ ...defaults, [key]: '' })
      assert.throws(() => readInputs({}), new RegExp(`Input required and not supplied: ${key.toLowerCase()}`))
    }
  })

  for (const value of ['', '-1', '1.5', 'many']) {
    it(`rejects max-targets ${JSON.stringify(value)}`, () => {
      set({ 'MAX-TARGETS': value })
      assert.throws(() => readInputs({}), /Invalid 'max-targets'/)
    })
  }
})
