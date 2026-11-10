import * as core from '@actions/core'
import { closingParser } from './comment.ts'
import { dim, escapeHtml, logStatus, paint, plural, summaryStatus } from './format.ts'
import { gitIn, isShallow, listCommits, previousTag, tagExists, type Commit, type Git } from './git.ts'
import { errorMessage, GitHub } from './github.ts'
import {
  findClosed,
  findPullRequests,
  notify,
  toTarget,
  type Filters,
  type Repo,
  type Result,
  type Target,
  type TargetKinds
} from './release.ts'

export { errorMessage }

export interface Inputs {
  tag: string
  version: string
  previousTag: string
  releaseUrl: string
  paths: string[]
  comment: string
  labels: string[]
  filters: Filters
  token: string
  dryRun: boolean
  maxTargets: number
  summary: boolean
  repository: string
  apiUrl: string
  graphqlUrl: string
  serverUrl: string
  workspace: string
}

export interface Deps {
  git?: Git
  gh?: GitHub
  pause?: () => Promise<void>
}

// GitHub asks for at least one second between requests that write:
// https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#pause-between-mutative-requests
const WRITE_PAUSE_MS = 1000

const TARGET_KINDS: string[] = ['all', 'pull-requests', 'issues'] satisfies TargetKinds[]

const lines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)

export function readInputs(env: NodeJS.ProcessEnv = process.env): Inputs {
  const maxTargets = core.getInput('max-targets').trim()
  if (!/^\d+$/.test(maxTargets)) throw new Error(`Invalid 'max-targets' '${maxTargets}': it must be a whole number, with 0 for no limit.`)
  const targets = core.getInput('targets').trim() || 'all'
  if (!TARGET_KINDS.includes(targets)) throw new Error(`Invalid 'targets' '${targets}': it must be ${TARGET_KINDS.join(', ')}.`)
  const token = core.getInput('token', { required: true })
  core.setSecret(token)
  return {
    tag: core.getInput('tag', { required: true }).trim(),
    version: core.getInput('version', { required: true }).trim(),
    previousTag: core.getInput('previous-tag').trim(),
    releaseUrl: core.getInput('release-url').trim(),
    paths: lines(core.getInput('paths')),
    comment: core.getInput('comment'),
    labels: lines(core.getInput('labels')),
    filters: {
      targets: targets as TargetKinds,
      skipLabels: lines(core.getInput('skip-labels')),
      skipAuthors: lines(core.getInput('skip-authors'))
    },
    token,
    dryRun: core.getBooleanInput('dry-run'),
    maxTargets: Number.parseInt(maxTargets, 10),
    summary: core.getBooleanInput('summary'),
    repository: env.GITHUB_REPOSITORY ?? '',
    apiUrl: env.GITHUB_API_URL || 'https://api.github.com',
    graphqlUrl: env.GITHUB_GRAPHQL_URL || 'https://api.github.com/graphql',
    serverUrl: env.GITHUB_SERVER_URL || 'https://github.com',
    workspace: env.GITHUB_WORKSPACE || process.cwd()
  }
}

interface Release {
  base: string | undefined
  commits: Commit[]
  results: Result[]
}

/** Runs the action. Any failure ends the step with a single readable error. */
export async function run(inputs: Inputs, deps: Deps = {}): Promise<void> {
  try {
    const repo = parseRepository(inputs.repository)
    const git = deps.git ?? gitIn(inputs.workspace)
    const gh = deps.gh ?? new GitHub({ token: inputs.token, apiUrl: inputs.apiUrl, graphqlUrl: inputs.graphqlUrl, log: core.info })
    const pause = deps.pause ?? (() => new Promise<void>(resolve => setTimeout(resolve, WRITE_PAUSE_MS)))

    const base = await resolveBase(git, inputs)
    const commits = await listCommits(git, base, inputs.tag, inputs.paths)
    core.info(
      `${paint('1', 'Release')} ${paint('36', inputs.tag)} ${dim(`(${base ? `since ${base}` : 'first release'}, ${plural(commits.length, 'commit')})`)}`
    )

    const targets = await findTargets(gh, repo, commits, inputs.serverUrl)
    if (inputs.maxTargets > 0 && targets.length > inputs.maxTargets) {
      throw new Error(
        `Found ${targets.length} pull requests and issues, more than 'max-targets' (${inputs.maxTargets}). Nothing was changed. Raise 'max-targets', or set it to 0 for no limit.`
      )
    }
    const results = await notify(gh, repo, targets, { ...inputs, pause })

    const release: Release = { base, commits, results }
    publish(release)
    log(inputs, release)
    if (inputs.summary) await writeSummary(inputs, release)

    const failed = results.filter(result => result.status === 'failed')
    if (failed.length > 0) {
      throw new Error(
        `Failed to update ${failed.map(result => `#${result.number}`).join(', ')}. Re-running is safe: existing comments are not repeated.`
      )
    }
  } catch (err) {
    core.setFailed(errorMessage(err))
  }
}

function parseRepository(repository: string): Repo {
  const [owner, repo, ...rest] = repository.split('/')
  if (!owner || !repo || rest.length > 0) throw new Error(`GITHUB_REPOSITORY must be 'owner/repo', got '${repository}'.`)
  return { owner, repo }
}

async function resolveBase(git: Git, { tag, version, previousTag: explicit }: Inputs): Promise<string | undefined> {
  if (await isShallow(git)) {
    throw new Error("The checkout is a shallow clone, so the release's commits can't be listed. Set 'fetch-depth: 0' on actions/checkout.")
  }
  for (const name of [tag, explicit].filter(Boolean)) {
    if (!(await tagExists(git, name)))
      throw new Error(`Tag '${name}' was not found in the checkout. Run this action after the release step, in the same job.`)
  }
  return explicit || (await previousTag(git, tag, version))
}

async function findTargets(gh: GitHub, repo: Repo, commits: Commit[], serverUrl: string): Promise<Target[]> {
  if (commits.length === 0) return []
  const prs = await findPullRequests(gh, repo, commits)
  const texts = [...prs.map(pr => pr.body ?? ''), ...commits.map(commit => commit.message)]
  const closed = await findClosed(gh, repo, texts, closingParser(repo.owner, repo.repo, serverUrl), new Set(prs.map(pr => pr.number)))
  return [...prs.map(pr => toTarget(pr, 'pr')), ...closed].sort((a, b) => a.number - b.number)
}

function publish({ base, commits, results }: Release): void {
  const numbers = (keep: (result: Result) => boolean): string => JSON.stringify(results.filter(keep).map(result => result.number))
  core.setOutput('previous-tag', base ?? '')
  core.setOutput('commits', String(commits.length))
  core.setOutput(
    'pull-requests',
    numbers(r => r.kind === 'pr')
  )
  core.setOutput(
    'issues',
    numbers(r => r.kind === 'issue')
  )
  core.setOutput(
    'commented',
    numbers(r => r.status === 'commented')
  )
  core.setOutput(
    'skipped',
    numbers(r => ['already-commented', 'filtered', 'forbidden', 'not-found'].includes(r.status))
  )
  core.setOutput(
    'failed',
    numbers(r => r.status === 'failed')
  )
  core.setOutput('json', JSON.stringify(results))
}

const label = (target: Target): string => `${target.kind === 'pr' ? 'PR' : 'issue'} #${target.number}`

function log({ tag, dryRun }: Inputs, { results }: Release): void {
  if (dryRun) core.notice('Dry run: no comments or labels were written.', { title: 'psr-success-comment' })
  if (results.length === 0) core.info(dim('No pull requests or issues to update.'))

  for (const result of results) {
    core.info(
      `${logStatus(result.status).padEnd(28)} ${label(result).padEnd(12)} ${dim(result.url)}${result.status === 'filtered' ? dim(` (${result.detail})`) : ''}`
    )
    if (result.status === 'forbidden' || result.status === 'not-found') {
      core.warning(`Skipped ${label(result)} for ${tag}: ${result.detail}`, { title: 'Release comment skipped' })
    } else if (result.status === 'failed') {
      core.error(`Could not update ${label(result)} for ${tag}: ${result.detail}`, { title: 'Release comment failed' })
    }
  }
}

async function writeSummary({ tag, releaseUrl, dryRun }: Inputs, { base, commits, results }: Release): Promise<void> {
  const name = `<code>${escapeHtml(tag)}</code>`
  const summary = core.summary
    .addHeading(`Release comments: ${releaseUrl ? `<a href="${escapeHtml(releaseUrl)}">${name}</a>` : name}`, 2)
    .addRaw(
      `${base ? `Since <code>${escapeHtml(base)}</code>` : 'First release'}, ${plural(commits.length, 'commit')}${dryRun ? ' (dry run)' : ''}.`,
      true
    )

  if (results.length === 0) {
    summary.addRaw('No pull requests or issues to update.', true)
  } else {
    // The Detail column only appears when a target was filtered out or something went wrong.
    const detail = results.some(result => result.detail)
    const header = ['Target', 'Result', ...(detail ? ['Detail'] : [])].map(data => ({ data, header: true }))
    summary.addTable([
      header,
      ...results.map(result => [
        `<a href="${escapeHtml(result.url)}">${escapeHtml(label(result))}</a>`,
        summaryStatus(result.status),
        ...(detail ? [escapeHtml(result.detail ?? '–')] : [])
      ])
    ])
  }
  await summary.write()
}
