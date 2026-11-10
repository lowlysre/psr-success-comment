export class HttpError extends Error {
  readonly status: number
  /** True when the response was a rate limit, which also uses 403 but is not a permission problem. */
  readonly rateLimited: boolean
  constructor(status: number, message: string, rateLimited = false) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.rateLimited = rateLimited
  }
}

export interface GraphQLError {
  type?: string
  message: string
}

export interface GitHubOptions {
  token: string
  apiUrl: string
  graphqlUrl: string
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  log?: (message: string) => void
}

export interface RequestOptions {
  /** Retry on network errors and 5xx. Leave off for requests that are not idempotent. */
  retry?: boolean
}

// Same retry budget as @semantic-release/github (lib/definitions/retry.js).
const RETRIES = 3
const MAX_WAIT_MS = 5 * 60_000
const TIMEOUT_MS = 30_000

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** A small GitHub REST and GraphQL client: serial requests, bounded retries, and rate-limit waits. */
export class GitHub {
  readonly #options: GitHubOptions
  readonly #fetch: typeof fetch
  readonly #sleep: (ms: number) => Promise<void>
  readonly #now: () => number

  constructor(options: GitHubOptions) {
    this.#options = { ...options, apiUrl: options.apiUrl.replace(/\/+$/, '') }
    this.#fetch = options.fetch ?? fetch
    this.#sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.#now = options.now ?? Date.now
  }

  async request<T>(method: string, path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    const res = await this.#send(method, `${this.#options.apiUrl}${path}`, body, options.retry ?? method === 'GET')
    return (await res.json()) as T
  }

  /** Collects every page of a list endpoint by following the `link` header. */
  async paginate<T>(path: string): Promise<T[]> {
    const items: T[] = []
    let url: string | undefined = `${this.#options.apiUrl}${path}${path.includes('?') ? '&' : '?'}per_page=100`
    while (url) {
      const res = await this.#send('GET', url, undefined, true)
      items.push(...((await res.json()) as T[]))
      url = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1]
      if (url && new URL(url).origin !== new URL(this.#options.apiUrl).origin) {
        throw new Error(`Refusing to follow a pagination link to another origin: ${url}`)
      }
    }
    return items
  }

  /** Runs a read-only query. NOT_FOUND errors come back with partial data; any other error throws. */
  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.#send('POST', this.#options.graphqlUrl, { query, variables }, true)
    const { data, errors = [] } = (await res.json()) as { data?: T; errors?: GraphQLError[] }
    const fatal = errors.filter(error => error.type !== 'NOT_FOUND')
    if (fatal.length > 0 || !data) {
      throw new Error(`GraphQL query failed: ${fatal.map(error => error.message).join('; ') || 'no data returned'}`)
    }
    return data
  }

  async #send(method: string, url: string, body: unknown, retry: boolean): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const canRetry = attempt < RETRIES
      let res: Response
      try {
        res = await this.#fetch(url, {
          method,
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${this.#options.token}`,
            'user-agent': 'psr-success-comment',
            'x-github-api-version': '2022-11-28',
            ...(body === undefined ? {} : { 'content-type': 'application/json' })
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS)
        })
      } catch (err) {
        if (!retry || !canRetry) throw new Error(`${method} ${url} failed: ${errorMessage(err)}`, { cause: err })
        await this.#wait(method, url, 1000 * 2 ** attempt, errorMessage(err))
        continue
      }
      if (res.ok) return res

      const text = await res.text()
      const limited = rateLimitWait(res, text, attempt, this.#now())
      if (limited !== undefined && canRetry && limited <= MAX_WAIT_MS) {
        await this.#wait(method, url, limited, 'rate limited')
      } else if (limited === undefined && res.status >= 500 && retry && canRetry) {
        await this.#wait(method, url, 1000 * 2 ** attempt, `HTTP ${res.status}`)
      } else {
        throw new HttpError(
          res.status,
          `${method} ${new URL(url).pathname} returned ${res.status}: ${describe(text)}`,
          limited !== undefined
        )
      }
    }
  }

  async #wait(method: string, url: string, ms: number, why: string): Promise<void> {
    this.#options.log?.(`${method} ${new URL(url).pathname}: ${why}, retrying in ${Math.ceil(ms / 1000)}s`)
    await this.#sleep(ms)
  }
}

/**
 * How long to wait before retrying a rate-limited response, or undefined when the response is not a
 * rate limit. Follows "Handle rate limit errors appropriately" in GitHub's REST best practices:
 * https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
 */
export function rateLimitWait(res: Response, text: string, attempt: number, now: number): number | undefined {
  if (res.status !== 403 && res.status !== 429) return undefined
  const retryAfter = Number.parseInt(res.headers.get('retry-after') ?? '', 10)
  if (Number.isFinite(retryAfter)) return Math.max(retryAfter, 0) * 1000
  if (res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number.parseInt(res.headers.get('x-ratelimit-reset') ?? '', 10)
    return Number.isFinite(reset) ? Math.max(reset * 1000 - now, 0) + 1000 : 60_000
  }
  return res.status === 429 || /rate limit/i.test(text) ? 60_000 * 2 ** attempt : undefined
}

function describe(text: string): string {
  try {
    const { message } = JSON.parse(text) as { message?: unknown }
    if (typeof message === 'string') return message
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return text.slice(0, 200) || 'no response body'
}
