import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { closingParser, marker } from '../src/comment.ts'
import type { Commit } from '../src/git.ts'
import { findClosed, findPullRequests, notify, type NotifyOptions, type Target } from '../src/release.ts'
import { fakeGitHub, urlOf, type FakeGitHub } from './helpers.ts'

const repo = { owner: 'acme', repo: 'widgets' }
const sha = (n: number): string => n.toString(16).padStart(40, '0')
const commit = (n: number, message = `commit ${n}`): Commit => ({ sha: sha(n), message })
const parse = closingParser('acme', 'widgets', 'https://github.com')

let fake: FakeGitHub
beforeEach(async () => {
  fake = await fakeGitHub()
})
afterEach(() => fake.close())

describe('findPullRequests', () => {
  it('keeps a pull request whose merge commit is in the release, without listing its commits', async () => {
    fake.prs.set(10, { body: 'Fixes #1', merge: sha(1) })
    fake.associated.set(sha(1), [10])
    const prs = await findPullRequests(fake.gh, repo, [commit(1), commit(2)])
    assert.deepEqual(prs, [{ number: 10, url: urlOf(10, true), body: 'Fixes #1', mergeCommit: { oid: sha(1) } }])
    assert.deepEqual(
      fake.calls.map(call => call.path),
      ['/graphql']
    )
  })

  it('keeps a pull request when one of its own commits is in the release', async () => {
    fake.prs.set(11, { merge: sha(99), commits: [sha(50), sha(2)] })
    fake.associated.set(sha(2), [11])
    assert.deepEqual(
      (await findPullRequests(fake.gh, repo, [commit(2)])).map(pr => pr.number),
      [11]
    )
  })

  it('drops a pull request that only contains a release commit', async () => {
    fake.prs.set(12, { commits: [sha(60)] })
    fake.prs.set(13, { merge: sha(98), commits: [] })
    fake.associated.set(sha(3), [12, 13])
    assert.deepEqual(await findPullRequests(fake.gh, repo, [commit(3)]), [])
  })

  it('returns each pull request once, in number order, and skips commits GitHub does not know', async () => {
    fake.prs.set(21, { merge: sha(2) })
    fake.prs.set(20, { merge: sha(1) })
    fake.associated.set(sha(1), [21, 20])
    fake.associated.set(sha(2), [21])
    const prs = await findPullRequests(fake.gh, repo, [commit(1), commit(2), commit(3)])
    assert.deepEqual(
      prs.map(pr => pr.number),
      [20, 21]
    )
  })

  it('pages through a commit with more pull requests than one page holds', async () => {
    fake.pageSize = 2
    for (const number of [30, 31, 32, 33, 34]) fake.prs.set(number, { merge: sha(1) })
    fake.associated.set(sha(1), [30, 31, 32, 33, 34])
    const prs = await findPullRequests(fake.gh, repo, [commit(1)])
    assert.deepEqual(
      prs.map(pr => pr.number),
      [30, 31, 32, 33, 34]
    )
    assert.equal(fake.calls.length, 3)
    assert.deepEqual((fake.calls[1]?.body as { variables: unknown }).variables, {
      owner: 'acme',
      repo: 'widgets',
      sha: sha(1),
      cursor: '2'
    })
  })

  it('queries commits in chunks of 100', async () => {
    const commits = Array.from({ length: 250 }, (_, i) => commit(i + 1))
    await findPullRequests(fake.gh, repo, commits)
    assert.equal(fake.calls.length, 3)
    const aliases = fake.calls.map(call => (call.body as { query: string }).query.match(/c\d+: object/g)?.length)
    assert.deepEqual(aliases, [100, 100, 50])
  })
})

describe('findClosed', () => {
  it('resolves closing references to issues and pull requests', async () => {
    fake.issues.add(1).add(2)
    fake.prs.set(3, {})
    const targets = await findClosed(fake.gh, repo, ['Fixes #2 and closes #3', 'fix: x\n\nResolves #1', ''], parse, new Set())
    assert.deepEqual(targets, [
      { number: 1, url: urlOf(1, false), kind: 'issue' },
      { number: 2, url: urlOf(2, false), kind: 'issue' },
      { number: 3, url: urlOf(3, true), kind: 'pr' }
    ])
  })

  it('skips known numbers, duplicates, and numbers that do not exist', async () => {
    fake.issues.add(1).add(2)
    const targets = await findClosed(fake.gh, repo, ['Fixes #1, fixes #2, fixes #404', 'Closes #2'], parse, new Set([1]))
    assert.deepEqual(
      targets.map(target => target.number),
      [2]
    )
    assert.doesNotMatch((fake.calls[0]?.body as { query: string }).query, /i1:/)
  })

  it('makes no request when nothing is referenced', async () => {
    assert.deepEqual(await findClosed(fake.gh, repo, ['chore: nothing here'], parse, new Set()), [])
    assert.equal(fake.calls.length, 0)
  })
})

describe('notify', () => {
  const targets: Target[] = [
    { number: 10, kind: 'pr', url: urlOf(10, true) },
    { number: 1, kind: 'issue', url: urlOf(1, false) }
  ]
  let pauses: number
  const options = (over: Partial<NotifyOptions> = {}): NotifyOptions => ({
    tag: 'v1.2.3',
    version: '1.2.3',
    releaseUrl: 'https://github.test/acme/widgets/releases/tag/v1.2.3',
    comment: '',
    labels: ['released'],
    dryRun: false,
    pause: async () => void pauses++,
    ...over
  })

  beforeEach(() => {
    pauses = 0
    fake.prs.set(10, {})
    fake.issues.add(1)
  })

  it('comments on and labels each target, pausing after every write', async () => {
    const results = await notify(fake.gh, repo, targets, options())
    assert.deepEqual(
      results.map(result => result.status),
      ['commented', 'commented']
    )
    assert.match(fake.comments.get(10)?.[0] as string, /^:tada: This PR is included in version 1\.2\.3 :tada:/)
    assert.match(fake.comments.get(1)?.[0] as string, /^:tada: This issue has been resolved in version 1\.2\.3 :tada:/)
    assert.ok(fake.comments.get(1)?.[0]?.endsWith(marker('v1.2.3')))
    assert.deepEqual(fake.labels.get(10), ['released'])
    assert.deepEqual(fake.labels.get(1), ['released'])
    assert.equal(pauses, 4)
  })

  it('does not comment twice on a re-run, but still applies labels', async () => {
    await notify(fake.gh, repo, targets, options({ labels: [] }))
    const results = await notify(fake.gh, repo, targets, options())
    assert.deepEqual(
      results.map(result => result.status),
      ['already-commented', 'already-commented']
    )
    assert.equal(fake.comments.get(10)?.length, 1)
    assert.deepEqual(fake.labels.get(10), ['released'])
  })

  it('comments again for a different release', async () => {
    await notify(fake.gh, repo, targets, options())
    const results = await notify(fake.gh, repo, targets, options({ tag: 'v1.2.4', version: '1.2.4' }))
    assert.equal(results[0]?.status, 'commented')
    assert.equal(fake.comments.get(10)?.length, 2)
  })

  it('finds an existing comment on a later page', async () => {
    fake.pageSize = 2
    fake.comments.set(10, ['a', 'b', 'c', `old\n\n${marker('v1.2.3')}`])
    const results = await notify(fake.gh, repo, [targets[0] as Target], options({ labels: [] }))
    assert.equal(results[0]?.status, 'already-commented')
    assert.equal(fake.comments.get(10)?.length, 4)
  })

  it('adds no labels when none are configured', async () => {
    await notify(fake.gh, repo, targets, options({ labels: [] }))
    assert.equal(fake.labels.size, 0)
    assert.equal(pauses, 2)
  })

  it('writes nothing in a dry run, and reports what a real run would do', async () => {
    fake.comments.set(1, [marker('v1.2.3')])
    const results = await notify(fake.gh, repo, targets, options({ dryRun: true }))
    assert.deepEqual(
      results.map(result => result.status),
      ['would-comment', 'already-commented']
    )
    assert.ok(fake.calls.every(call => call.method === 'GET'))
    assert.equal(pauses, 0)
  })

  it('skips a target on 403 or 404 and carries on', async () => {
    fake.canned.set('POST /repos/acme/widgets/issues/10/comments', [
      { status: 403, body: { message: 'Resource not accessible by integration' } }
    ])
    const results = await notify(fake.gh, repo, [...targets, { number: 404, kind: 'issue', url: urlOf(404, false) }], options())
    assert.deepEqual(
      results.map(result => result.status),
      ['forbidden', 'commented', 'not-found']
    )
    assert.match(results[0]?.detail as string, /returned 403: Resource not accessible by integration/)
    assert.equal(fake.labels.has(10), false)
  })

  it('marks other errors failed, including an exhausted rate limit, and carries on', async () => {
    fake.canned.set('POST /repos/acme/widgets/issues/10/comments', [{ status: 422, body: { message: 'Validation Failed' } }])
    fake.canned.set('POST /repos/acme/widgets/issues/1/labels', [{ status: 403, headers: { 'retry-after': '9999' } }])
    const results = await notify(fake.gh, repo, targets, options())
    assert.deepEqual(
      results.map(result => result.status),
      ['failed', 'failed']
    )
    assert.match(results[0]?.detail as string, /422: Validation Failed/)
    assert.equal(fake.comments.get(1)?.length, 1)
  })

  it('uses a custom comment template', async () => {
    await notify(fake.gh, repo, [targets[0] as Target], options({ comment: 'Out in {version}' }))
    assert.equal(fake.comments.get(10)?.[0], `Out in 1.2.3\n\n${marker('v1.2.3')}`)
  })
})
