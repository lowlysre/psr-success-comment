import { renderComment, marker, type ClosingParser, type Kind } from './comment.ts'
import type { Commit } from './git.ts'
import { errorMessage, HttpError, type GitHub } from './github.ts'

export interface Repo {
  owner: string
  repo: string
}

export interface PullRequest {
  number: number
  url: string
  body: string | null
  mergeCommit: { oid: string } | null
}

export interface Target {
  number: number
  kind: Kind
  url: string
}

export type Status = 'commented' | 'already-commented' | 'would-comment' | 'forbidden' | 'not-found' | 'failed'

export interface Result extends Target {
  status: Status
  detail?: string
}

export interface NotifyOptions {
  tag: string
  version: string
  releaseUrl: string
  comment: string
  labels: string[]
  dryRun: boolean
  /** Waits between write requests. */
  pause: () => Promise<void>
}

interface PullRequestPage {
  pageInfo: { hasNextPage: boolean; endCursor: string | null }
  nodes: PullRequest[]
}
type CommitNode = { associatedPullRequests?: PullRequestPage } | null

const CHUNK = 100
const PAGE =
  'associatedPullRequests(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { number url body mergeCommit { oid } } }'
const NEXT_PAGE = `query($owner: String!, $repo: String!, $sha: GitObjectID!, $cursor: String) {
  repository(owner: $owner, name: $repo) { commit: object(oid: $sha) { ... on Commit { ${PAGE} } } }
}`

function* chunks<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size)
}

/**
 * The pull requests that brought the release's commits in. GitHub's `associatedPullRequests` also
 * lists pull requests that merely contain a commit, so each candidate is kept only when its merge
 * commit or one of its own commits is in the release, as @semantic-release/github does.
 */
export async function findPullRequests(gh: GitHub, { owner, repo }: Repo, commits: Commit[]): Promise<PullRequest[]> {
  const shas = new Set(commits.map(commit => commit.sha))
  const candidates = new Map<number, PullRequest>()

  for (const chunk of chunks([...shas], CHUNK)) {
    const fields = chunk.map((sha, i) => `c${i}: object(oid: "${sha}") { ... on Commit { ${PAGE} } }`).join('\n')
    const query = `query($owner: String!, $repo: String!, $cursor: String) { repository(owner: $owner, name: $repo) {\n${fields}\n} }`
    const { repository } = await gh.graphql<{ repository: Record<string, CommitNode> }>(query, { owner, repo, cursor: null })

    for (const [i, sha] of chunk.entries()) {
      let page = repository[`c${i}`]?.associatedPullRequests
      while (page) {
        for (const pr of page.nodes) candidates.set(pr.number, pr)
        if (!page.pageInfo.hasNextPage) break
        const next = await gh.graphql<{ repository: { commit: CommitNode } }>(NEXT_PAGE, {
          owner,
          repo,
          sha,
          cursor: page.pageInfo.endCursor
        })
        page = next.repository.commit?.associatedPullRequests
      }
    }
  }

  const prs: PullRequest[] = []
  for (const pr of [...candidates.values()].sort((a, b) => a.number - b.number)) {
    if (pr.mergeCommit && shas.has(pr.mergeCommit.oid)) {
      prs.push(pr)
      continue
    }
    const own = await gh.paginate<{ sha: string }>(`/repos/${owner}/${repo}/pulls/${pr.number}/commits`)
    if (own.some(commit => shas.has(commit.sha))) prs.push(pr)
  }
  return prs
}

/** The issues and pull requests that `texts` close with a keyword, minus the numbers in `known`. */
export async function findClosed(
  gh: GitHub,
  { owner, repo }: Repo,
  texts: string[],
  parse: ClosingParser,
  known: Set<number>
): Promise<Target[]> {
  const numbers = [...new Set(texts.flatMap(parse))].filter(number => !known.has(number)).sort((a, b) => a - b)
  const targets: Target[] = []

  for (const chunk of chunks(numbers, CHUNK)) {
    const fields = chunk
      .map(n => `i${n}: issueOrPullRequest(number: ${n}) { __typename ... on Issue { number url } ... on PullRequest { number url } }`)
      .join('\n')
    const query = `query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) {\n${fields}\n} }`
    const { repository } = await gh.graphql<{ repository: Record<string, (Omit<Target, 'kind'> & { __typename: string }) | null> }>(query, {
      owner,
      repo
    })
    for (const number of chunk) {
      // A number that is not an issue or pull request in this repository comes back as null.
      const node = repository[`i${number}`]
      if (node) targets.push({ number: node.number, url: node.url, kind: node.__typename === 'PullRequest' ? 'pr' : 'issue' })
    }
  }
  return targets
}

/**
 * Comments on and labels each target, one request at a time. A target that already carries this
 * release's marker is not commented on again. 403 and 404 skip the target; other errors mark it failed.
 */
export async function notify(gh: GitHub, { owner, repo }: Repo, targets: Target[], options: NotifyOptions): Promise<Result[]> {
  const results: Result[] = []
  const needle = marker(options.tag)

  for (const target of targets) {
    const issue = `/repos/${owner}/${repo}/issues/${target.number}`
    try {
      const comments = await gh.paginate<{ body?: string | null }>(`${issue}/comments`)
      const exists = comments.some(comment => comment.body?.includes(needle))
      if (options.dryRun) {
        results.push({ ...target, status: exists ? 'already-commented' : 'would-comment' })
        continue
      }
      if (!exists) {
        const body = renderComment(options.comment, {
          kind: target.kind,
          version: options.version,
          tag: options.tag,
          releaseUrl: options.releaseUrl
        })
        await gh.request('POST', `${issue}/comments`, { body })
        await options.pause()
      }
      if (options.labels.length > 0) {
        // Adding a label the target already has is a no-op, so this request is safe to retry.
        await gh.request('POST', `${issue}/labels`, { labels: options.labels }, { retry: true })
        await options.pause()
      }
      results.push({ ...target, status: exists ? 'already-commented' : 'commented' })
    } catch (err) {
      const code = err instanceof HttpError && !err.rateLimited ? err.status : 0
      results.push({ ...target, status: code === 403 ? 'forbidden' : code === 404 ? 'not-found' : 'failed', detail: errorMessage(err) })
    }
  }
  return results
}
