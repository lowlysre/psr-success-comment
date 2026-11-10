import issueParser from 'issue-parser'

export type Kind = 'pr' | 'issue'

export interface CommentContext {
  kind: Kind
  version: string
  tag: string
  releaseUrl: string
}

// GraphQL's Int is a signed 32-bit integer; a larger number in a query fails the whole query.
const MAX_NUMBER = 2 ** 31 - 1

/** A hidden HTML comment that identifies this release's comment, so a re-run can find it and not post twice. */
export function marker(tag: string): string {
  // A raw "--" or ">" in the tag could end the HTML comment early.
  const safe = encodeURIComponent(tag).replace(/-/g, '%2D')
  return `<!-- psr-success-comment tag=${safe} -->`
}

/**
 * The comment body. The default wording follows @semantic-release/github's getSuccessComment; a
 * template replaces `{version}`, `{tag}`, `{url}`, and `{type}`. The marker is always appended.
 */
export function renderComment(template: string, context: CommentContext): string {
  const { kind, version, tag, releaseUrl } = context
  const values: Record<string, string> = { version, tag, url: releaseUrl, type: kind === 'pr' ? 'pull request' : 'issue' }
  const body = template.trim()
    ? template.trim().replace(/\{(version|tag|url|type)\}/g, (_, key: string) => values[key] as string)
    : `:tada: This ${kind === 'pr' ? 'PR is included' : 'issue has been resolved'} in version ${version} :tada:` +
      (releaseUrl ? `\n\nThe release is available on [${tag}](${releaseUrl})` : '')
  return `${body}\n\n${marker(tag)}`
}

export type ClosingParser = (text: string) => number[]

/**
 * Finds the issues a text closes with a keyword such as "Fixes #12", using the same parser and the
 * same-repository filter as @semantic-release/github (lib/success.js).
 */
export function closingParser(owner: string, repo: string, serverUrl: string): ClosingParser {
  const parse = issueParser('github', serverUrl && serverUrl !== 'https://github.com' ? { hosts: [serverUrl] } : {})
  const slug = `${owner}/${repo}`.toLowerCase()
  return text =>
    (parse(text).actions.close ?? [])
      .filter(action => !action.slug || action.slug.toLowerCase() === slug)
      .map(action => Number.parseInt(action.issue, 10))
      .filter(number => number > 0 && number <= MAX_NUMBER)
}
