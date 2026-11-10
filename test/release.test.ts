import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { closingParser, marker } from '../src/comment.ts'
import type { Commit } from '../src/git.ts'
import { filterReason, findClosed, findPullRequests, notify, type Filters, type NotifyOptions, type Target } from '../src/release.ts'
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
    fake.authors.set(10, 'octocat')
    fake.labels.set(10, ['bug'])
    fake.associated.set(sha(1), [10])
    const prs = await findPullRequests(fake.gh, repo, [commit(1), commit(2)])
    assert.deepEqual(prs, [
      {
        number: 10,
        url: urlOf(10, true),
        author: { login: 'octocat' },
        labels: { nodes: [{ name: 'bug' }] },
        body: 'Fixes #1',
        mergeCommit: { oid: sha(1) }
      }
    ])
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

  it('keeps every query under GitHub GraphQL 500,000 node limit', async () => {
    fake.issues.add(1)
    const commits = Array.from({ length: 100 }, (_, i) => commit(i + 1))
    await findPullRequests(fake.gh, repo, commits)
    await findClosed(fake.gh, repo, [Array.from({ length: 100 }, (_, i) => `Fixes #${i + 1}`).join(', ')], parse, new Set())
    const queries = fake.calls.map(call => (call.body as { query: string }).query)
    assert.ok(queries.length >= 2)
    for (const query of queries) {
      const aliases = query.match(/(?:c\d+: object|i\d+: issueOrPullRequest)/g)?.length ?? 1
      const pullRequests = Number(/associatedPullRequests\(first: (\d+)/.exec(query)?.[1] ?? 1)
      const labels = Number(/labels\(first: (\d+)/.exec(query)?.[1] ?? 0)
      // Every alias is one node, plus its pull requests, each with its labels.
      const nodes = aliases * (1 + pullRequests * (1 + labels))
      assert.ok(nodes < 500_000, `${nodes} possible nodes`)
    }
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
    fake.authors.set(2, 'octocat')
    fake.labels.set(2, ['bug', 'wontfix'])
    const targets = await findClosed(fake.gh, repo, ['Fixes #2 and closes #3', 'fix: x\n\nResolves #1', ''], parse, new Set())
    assert.deepEqual(targets, [
      { number: 1, kind: 'issue', url: urlOf(1, false), author: '', labels: [] },
      { number: 2, kind: 'issue', url: urlOf(2, false), author: 'octocat', labels: ['bug', 'wontfix'] },
      { number: 3, kind: 'pr', url: urlOf(3, true), author: '', labels: [] }
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

const noFilters: Filters = { targets: 'all', skipLabels: [], skipAuthors: [] }

describe('filterReason', () => {
  const pr: Target = { number: 10, kind: 'pr', url: urlOf(10, true), author: 'dependabot', labels: ['Dependencies', 'bug'] }
  const issue: Target = { number: 1, kind: 'issue', url: urlOf(1, false), author: '', labels: [] }

  it('keeps everything by default', () => {
    assert.equal(filterReason(pr, noFilters), undefined)
    assert.equal(filterReason(issue, noFilters), undefined)
  })

  it('filters by kind', () => {
    assert.equal(filterReason(pr, { ...noFilters, targets: 'issues' }), "targets is 'issues'")
    assert.equal(filterReason(issue, { ...noFilters, targets: 'issues' }), undefined)
    assert.equal(filterReason(issue, { ...noFilters, targets: 'pull-requests' }), "targets is 'pull-requests'")
    assert.equal(filterReason(pr, { ...noFilters, targets: 'pull-requests' }), undefined)
  })

  it('filters by label, ignoring case', () => {
    assert.equal(filterReason(pr, { ...noFilters, skipLabels: ['wontfix', 'dependencies'] }), "label 'Dependencies'")
    assert.equal(filterReason(pr, { ...noFilters, skipLabels: ['wontfix'] }), undefined)
  })

  it('does not treat [bot] as a suffix of a label', () => {
    const labeled = { ...pr, labels: ['automation'] }
    assert.equal(filterReason(labeled, { ...noFilters, skipLabels: ['automation[bot]'] }), undefined)
    assert.equal(
      filterReason({ ...pr, labels: ['automation[bot]'] }, { ...noFilters, skipLabels: ['Automation[BOT]'] }),
      "label 'automation[bot]'"
    )
    assert.equal(filterReason({ ...pr, labels: ['automation[bot]'] }, { ...noFilters, skipLabels: ['automation'] }), undefined)
  })

  it('filters by author, matching a bot with or without its [bot] suffix', () => {
    assert.equal(filterReason(pr, { ...noFilters, skipAuthors: ['Dependabot[bot]'] }), "author 'dependabot'")
    assert.equal(filterReason(pr, { ...noFilters, skipAuthors: ['dependabot'] }), "author 'dependabot'")
    assert.equal(filterReason({ ...pr, author: 'renovate[bot]' }, { ...noFilters, skipAuthors: ['renovate'] }), "author 'renovate[bot]'")
    assert.equal(filterReason(pr, { ...noFilters, skipAuthors: ['octocat'] }), undefined)
    assert.equal(filterReason(issue, { ...noFilters, skipAuthors: [''] }), undefined)
  })
})

describe('notify', () => {
  const targets: Target[] = [
    { number: 10, kind: 'pr', url: urlOf(10, true), author: 'octocat', labels: ['bug'] },
    { number: 1, kind: 'issue', url: urlOf(1, false), author: 'dependabot', labels: [] }
  ]
  let pauses: number
  const options = (over: Partial<NotifyOptions> = {}): NotifyOptions => ({
    tag: 'v1.2.3',
    version: '1.2.3',
    releaseUrl: 'https://github.test/acme/widgets/releases/tag/v1.2.3',
    comment: '',
    labels: ['released'],
    dryRun: false,
    filters: noFilters,
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
    const results = await notify(
      fake.gh,
      repo,
      [...targets, { number: 404, kind: 'issue', url: urlOf(404, false), author: '', labels: [] }],
      options()
    )
    assert.deepEqual(
      results.map(result => result.status),
      ['forbidden', 'commented', 'not-found']
    )
    assert.match(results[0]?.detail as string, /returned 403: Resource not accessible by integration/)
    assert.equal(fake.labels.has(10), false)
  })

  it('reports a posted comment even when adding the labels fails', async () => {
    fake.canned.set('POST /repos/acme/widgets/issues/10/labels', [{ status: 422, body: { message: 'Validation Failed' } }])
    const results = await notify(fake.gh, repo, targets, options())
    assert.deepEqual(
      results.map(result => [result.status, result.commented]),
      [
        ['failed', true],
        ['commented', true]
      ]
    )
    assert.equal(fake.comments.get(10)?.length, 1)
  })

  it('reports no comment when posting it fails, or when the target is filtered, already commented, or a dry run', async () => {
    fake.canned.set('POST /repos/acme/widgets/issues/10/comments', [{ status: 422, body: { message: 'Validation Failed' } }])
    assert.deepEqual(
      (await notify(fake.gh, repo, [targets[0] as Target], options())).map(result => result.commented),
      [false]
    )
    assert.deepEqual(
      (await notify(fake.gh, repo, targets, options({ dryRun: true }))).map(result => result.commented),
      [false, false]
    )
    assert.deepEqual(
      (await notify(fake.gh, repo, targets, options({ filters: { ...noFilters, skipLabels: ['bug'], skipAuthors: ['dependabot'] } }))).map(
        result => result.commented
      ),
      [false, false]
    )
    await notify(fake.gh, repo, targets, options())
    assert.deepEqual(
      (await notify(fake.gh, repo, targets, options())).map(result => result.commented),
      [false, false]
    )
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

  it('reports filtered targets without making a request for them', async () => {
    const results = await notify(
      fake.gh,
      repo,
      targets,
      options({ filters: { ...noFilters, skipLabels: ['bug'], skipAuthors: ['dependabot[bot]'] } })
    )
    assert.deepEqual(
      results.map(result => [result.status, result.detail]),
      [
        ['filtered', "label 'bug'"],
        ['filtered', "author 'dependabot'"]
      ]
    )
    assert.equal(fake.calls.length, 0)
    assert.equal(pauses, 0)
  })

  it('uses a custom comment template', async () => {
    await notify(fake.gh, repo, [targets[0] as Target], options({ comment: 'Out in {version}' }))
    assert.equal(fake.comments.get(10)?.[0], `Out in 1.2.3\n\n${marker('v1.2.3')}`)
  })
})
