import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { GitHub, HttpError, rateLimitWait } from '../src/github.ts'
import { fakeGitHub, type FakeGitHub } from './helpers.ts'

const response = (status: number, headers: Record<string, string> = {}): Response => new Response(null, { status, headers })

describe('rateLimitWait', () => {
  it('ignores responses that are not rate limits', () => {
    assert.equal(rateLimitWait(response(404), '', 0, 0), undefined)
    assert.equal(rateLimitWait(response(403), 'Resource not accessible by integration', 0, 0), undefined)
  })

  it('waits for retry-after seconds', () => {
    assert.equal(rateLimitWait(response(403, { 'retry-after': '7' }), '', 0, 0), 7000)
    assert.equal(rateLimitWait(response(429, { 'retry-after': '-1' }), '', 0, 0), 0)
  })

  it('waits until the primary limit resets, plus a second', () => {
    const headers = { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '100' }
    assert.equal(rateLimitWait(response(403, headers), '', 0, 90_000), 11_000)
    assert.equal(rateLimitWait(response(403, headers), '', 0, 200_000), 1000)
    assert.equal(rateLimitWait(response(403, { 'x-ratelimit-remaining': '0' }), '', 0, 0), 60_000)
  })

  it('waits a minute, then doubles, for a secondary limit without headers', () => {
    assert.equal(rateLimitWait(response(403), 'You have exceeded a secondary rate limit', 0, 0), 60_000)
    assert.equal(rateLimitWait(response(429), '', 2, 0), 240_000)
  })
})

describe('GitHub client', () => {
  let fake: FakeGitHub
  beforeEach(async () => {
    fake = await fakeGitHub()
    fake.issues.add(1)
  })
  afterEach(() => fake.close())

  it('sends the token, API version, and JSON body', async () => {
    let seen: Request | undefined
    const gh = new GitHub({
      token: 'secret',
      apiUrl: `${fake.url}/`,
      graphqlUrl: `${fake.url}/graphql`,
      fetch: (input, init) => {
        seen = new Request(input, init)
        return fetch(input, init)
      }
    })
    await gh.request('POST', '/repos/acme/widgets/issues/1/labels', { labels: ['released'] })
    assert.equal(seen?.headers.get('authorization'), 'Bearer secret')
    assert.equal(seen?.headers.get('x-github-api-version'), '2022-11-28')
    assert.equal(seen?.headers.get('content-type'), 'application/json')
    assert.deepEqual(fake.calls, [{ method: 'POST', path: '/repos/acme/widgets/issues/1/labels', body: { labels: ['released'] } }])
  })

  it('follows link headers to collect every page', async () => {
    fake.pageSize = 2
    fake.comments.set(1, ['a', 'b', 'c', 'd', 'e'])
    const comments = await fake.gh.paginate<{ body: string }>('/repos/acme/widgets/issues/1/comments')
    assert.deepEqual(
      comments.map(comment => comment.body),
      ['a', 'b', 'c', 'd', 'e']
    )
    assert.equal(fake.calls.length, 3)
  })

  it('refuses a pagination link to another origin', async () => {
    fake.canned.set('GET /repos/acme/widgets/issues/1/comments', [
      { status: 200, body: [], headers: { link: '<https://evil.test/x>; rel="next"' } }
    ])
    await assert.rejects(fake.gh.paginate('/repos/acme/widgets/issues/1/comments'), /another origin/)
  })

  it('retries a GET on 5xx with backoff, then succeeds', async () => {
    fake.canned.set('GET /repos/acme/widgets/issues/1/comments', [{ status: 502 }, { status: 503 }])
    assert.deepEqual(await fake.gh.paginate('/repos/acme/widgets/issues/1/comments'), [])
    assert.deepEqual(fake.waits, [1000, 2000])
  })

  it('gives up after three retries', async () => {
    fake.canned.set(
      'GET /repos/acme/widgets/issues/1/comments',
      Array.from({ length: 4 }, () => ({ status: 500, body: 'upstream down' }))
    )
    await assert.rejects(fake.gh.paginate('/repos/acme/widgets/issues/1/comments'), (err: HttpError) => {
      assert.equal(err.status, 500)
      assert.equal(err.rateLimited, false)
      assert.match(err.message, /GET \/repos\/acme\/widgets\/issues\/1\/comments returned 500: upstream down/)
      return true
    })
    assert.equal(fake.calls.length, 4)
  })

  it('does not retry a POST on 5xx unless told it is safe', async () => {
    const path = '/repos/acme/widgets/issues/1/comments'
    fake.canned.set(`POST ${path}`, [{ status: 500, body: '' }])
    await assert.rejects(fake.gh.request('POST', path, { body: 'x' }), /returned 500: no response body/)
    assert.equal(fake.calls.length, 1)

    fake.canned.set(`POST ${path}`, [{ status: 500 }])
    await fake.gh.request('POST', path, { body: 'x' }, { retry: true })
    assert.deepEqual(fake.comments.get(1), ['x'])
  })

  it('waits out a rate limit, even for a POST', async () => {
    const path = '/repos/acme/widgets/issues/1/comments'
    fake.canned.set(`POST ${path}`, [{ status: 403, headers: { 'retry-after': '3' } }])
    await fake.gh.request('POST', path, { body: 'x' })
    assert.deepEqual(fake.waits, [3000])
    assert.deepEqual(fake.comments.get(1), ['x'])
  })

  it('fails instead of waiting longer than five minutes, and flags the rate limit', async () => {
    fake.canned.set('GET /repos/acme/widgets/issues/1/comments', [{ status: 403, headers: { 'retry-after': '3600' } }])
    await assert.rejects(
      fake.gh.paginate('/repos/acme/widgets/issues/1/comments'),
      (err: HttpError) => err.status === 403 && err.rateLimited
    )
    assert.deepEqual(fake.waits, [])
  })

  it('reports the API message of a client error', async () => {
    await assert.rejects(fake.gh.request('GET', '/repos/acme/widgets/issues/2/comments'), (err: HttpError) => {
      assert.equal(err.status, 404)
      assert.match(err.message, /returned 404: Not Found/)
      return true
    })
  })

  it('retries network errors for safe requests only', async () => {
    let attempts = 0
    const logs: string[] = []
    const flaky: typeof fetch = (input, init) => (++attempts < 3 ? Promise.reject(new TypeError('socket hang up')) : fetch(input, init))
    const options = {
      token: 't',
      apiUrl: fake.url,
      graphqlUrl: `${fake.url}/graphql`,
      sleep: () => Promise.resolve(),
      log: (m: string) => logs.push(m)
    }
    assert.deepEqual(await new GitHub({ ...options, fetch: flaky }).paginate('/repos/acme/widgets/issues/1/comments'), [])
    assert.equal(attempts, 3)
    assert.match(logs[0] as string, /socket hang up, retrying in 1s/)

    const down: typeof fetch = () => Promise.reject(new TypeError('socket hang up'))
    await assert.rejects(new GitHub({ ...options, fetch: down }).request('POST', '/x', {}), /POST .*\/x failed: socket hang up/)
    await assert.rejects(
      new GitHub({ ...options, fetch: () => Promise.reject('offline') }).request('GET', '/x'),
      /GET .*\/x failed: offline/
    )
  })

  it('returns partial GraphQL data when the only errors are NOT_FOUND', async () => {
    const query = 'query { repository { i1: issueOrPullRequest(number: 1) { number } i9: issueOrPullRequest(number: 9) { number } } }'
    const data = await fake.gh.graphql<{ repository: Record<string, unknown> }>(query, {})
    assert.equal(data.repository.i9, null)
    assert.deepEqual(data.repository.i1, { __typename: 'Issue', number: 1, url: 'https://github.test/acme/widgets/issues/1' })
  })

  it('throws on any other GraphQL error, or on missing data', async () => {
    fake.canned.set('POST /graphql', [
      { status: 200, body: { data: null, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }, { message: 'second' }] } },
      { status: 200, body: {} }
    ])
    await assert.rejects(fake.gh.graphql('query { x }', {}), /GraphQL query failed: API rate limit exceeded; second/)
    await assert.rejects(fake.gh.graphql('query { x }', {}), /GraphQL query failed: no data returned/)
  })
})
