import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { GitHub } from '../src/github.ts'

export interface TestRepo {
  dir: string
  /** Commits a change to `file` and returns the commit SHA. */
  commit(message: string, file?: string): string
  tag(name: string): void
  git(...args: string[]): string
  remove(): void
}

/** A real git repository in a temporary directory. */
export function makeRepo(): TestRepo {
  const root = mkdtempSync(join(tmpdir(), 'psr-repo-'))
  const dir = join(root, 'repo')
  const config = join(root, 'gitconfig')
  mkdirSync(dir)
  writeFileSync(config, '')
  let count = 0
  const git = (...args: string[]): string =>
    execFileSync(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args],
      {
        cwd: dir,
        encoding: 'utf8',
        // Keeps the developer's own git configuration and hooks out of the test repository.
        env: { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_SYSTEM: config },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    ).trim()
  git('init', '--quiet', '--initial-branch=main')
  return {
    dir,
    git,
    commit(message, file = 'file.txt') {
      const path = join(dir, file)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${++count}\n`)
      git('add', '--all')
      git('commit', '--quiet', '--message', message)
      return git('rev-parse', 'HEAD')
    },
    tag: name => void git('tag', name),
    remove: () => rmSync(root, { recursive: true, force: true })
  }
}

export interface FakePullRequest {
  body?: string | null
  /** SHA of the merge commit, as GitHub reports it. */
  merge?: string
  /** SHAs of the pull request's own commits. */
  commits?: string[]
}

export interface Canned {
  status: number
  body?: unknown
  headers?: Record<string, string>
}

export interface Call {
  method: string
  path: string
  body: unknown
}

export interface FakeGitHub {
  gh: GitHub
  url: string
  calls: Call[]
  waits: number[]
  /** Pull requests by number. */
  prs: Map<number, FakePullRequest>
  /** Issue numbers. */
  issues: Set<number>
  /** Pull request numbers that GitHub associates with each commit SHA. */
  associated: Map<string, number[]>
  comments: Map<number, string[]>
  /** Labels by pull request or issue number: read by lookups, added to by the labels endpoint. */
  labels: Map<number, string[]>
  /** Author logins by pull request or issue number. */
  authors: Map<number, string>
  /** Canned responses, keyed by "METHOD /path", returned once each before the normal behavior. */
  canned: Map<string, Canned[]>
  pageSize: number
  close(): Promise<void>
}

export const urlOf = (number: number, pr: boolean): string => `https://github.test/acme/widgets/${pr ? 'pull' : 'issues'}/${number}`

/** A local HTTP server that behaves like the parts of the GitHub REST and GraphQL APIs the action uses. */
export async function fakeGitHub(): Promise<FakeGitHub> {
  const fake = {
    calls: [] as Call[],
    waits: [] as number[],
    prs: new Map<number, FakePullRequest>(),
    issues: new Set<number>(),
    associated: new Map<string, number[]>(),
    comments: new Map<number, string[]>(),
    labels: new Map<number, string[]>(),
    authors: new Map<number, string>(),
    canned: new Map<string, Canned[]>(),
    pageSize: 100
  }

  const node = (number: number, pr: boolean) => ({
    number,
    url: urlOf(number, pr),
    author: fake.authors.has(number) ? { login: fake.authors.get(number) } : null,
    labels: { nodes: (fake.labels.get(number) ?? []).map(name => ({ name })) }
  })

  const prNode = (number: number) => {
    const pr = fake.prs.get(number) as FakePullRequest
    return { ...node(number, true), body: pr.body ?? null, mergeCommit: pr.merge ? { oid: pr.merge } : null }
  }

  const prPage = (sha: string, cursor: string | null) => {
    const all = fake.associated.get(sha) ?? []
    const start = cursor ? Number(cursor) : 0
    const end = start + fake.pageSize
    return {
      associatedPullRequests: {
        pageInfo: { hasNextPage: end < all.length, endCursor: String(end) },
        nodes: all.slice(start, end).map(prNode)
      }
    }
  }

  const graphql = ({ query, variables }: { query: string; variables: { sha?: string; cursor?: string | null } }) => {
    const repository: Record<string, unknown> = {}
    const errors: { type: string; message: string }[] = []
    if (variables.sha) repository.commit = prPage(variables.sha, variables.cursor ?? null)
    for (const [, alias, sha] of query.matchAll(/(c\d+): object\(oid: "([0-9a-f]+)"\)/g)) {
      repository[alias as string] = fake.associated.has(sha as string) ? prPage(sha as string, null) : null
    }
    for (const [, alias, digits] of query.matchAll(/(i\d+): issueOrPullRequest\(number: (\d+)\)/g)) {
      const number = Number(digits)
      const pr = fake.prs.has(number)
      if (pr || fake.issues.has(number)) {
        repository[alias as string] = { __typename: pr ? 'PullRequest' : 'Issue', ...node(number, pr) }
      } else {
        repository[alias as string] = null
        errors.push({ type: 'NOT_FOUND', message: `Could not resolve to an issue or pull request with the number of ${number}.` })
      }
    }
    return { data: { repository }, ...(errors.length > 0 ? { errors } : {}) }
  }

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(typeof body === 'string' ? body : JSON.stringify(body))
  }

  const page = <T>(req: IncomingMessage, res: ServerResponse, items: T[]) => {
    const url = new URL(req.url as string, base)
    const number = Number(url.searchParams.get('page') ?? '1')
    const start = (number - 1) * fake.pageSize
    url.searchParams.set('page', String(number + 1))
    const headers: Record<string, string> = start + fake.pageSize < items.length ? { link: `<${url.href}>; rel="next"` } : {}
    send(res, 200, items.slice(start, start + fake.pageSize), headers)
  }

  const handle = (req: IncomingMessage, res: ServerResponse, raw: string) => {
    const method = req.method as string
    const path = (req.url as string).split('?')[0] as string
    const body = raw ? (JSON.parse(raw) as unknown) : undefined
    fake.calls.push({ method, path, body })

    const canned = fake.canned.get(`${method} ${path}`)?.shift()
    if (canned) return send(res, canned.status, canned.body ?? { message: `canned ${canned.status}` }, canned.headers)

    if (path === '/graphql') return send(res, 200, graphql(body as Parameters<typeof graphql>[0]))

    const match = /^\/repos\/acme\/widgets\/(pulls|issues)\/(\d+)\/(commits|comments|labels)$/.exec(path)
    const number = Number(match?.[2])
    const known = fake.prs.has(number) || fake.issues.has(number)
    if (!match || !known) return send(res, 404, { message: 'Not Found' })

    const [, , , resource] = match
    if (resource === 'commits')
      return page(
        req,
        res,
        (fake.prs.get(number)?.commits ?? []).map(sha => ({ sha }))
      )
    if (resource === 'comments' && method === 'GET')
      return page(
        req,
        res,
        (fake.comments.get(number) ?? []).map(text => ({ body: text }))
      )
    if (resource === 'comments') {
      fake.comments.set(number, [...(fake.comments.get(number) ?? []), (body as { body: string }).body])
      return send(res, 201, { html_url: `${urlOf(number, fake.prs.has(number))}#issuecomment-1` })
    }
    fake.labels.set(number, [...new Set([...(fake.labels.get(number) ?? []), ...(body as { labels: string[] }).labels])])
    return send(res, 200, [])
  }

  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()))
    req.on('end', () => handle(req, res, raw))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`

  const gh = new GitHub({
    token: 'test-token',
    apiUrl: base,
    graphqlUrl: `${base}/graphql`,
    sleep: async ms => void fake.waits.push(ms)
  })
  return Object.assign(fake, {
    gh,
    url: base,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  })
}
