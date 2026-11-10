import { execFile } from 'node:child_process'

export interface Commit {
  sha: string
  message: string
}

/** Runs git with the given arguments and resolves with stdout. */
export type Git = (args: string[]) => Promise<string>

export const gitIn =
  (cwd: string): Git =>
  args =>
    new Promise((resolve, reject) => {
      execFile('git', args, { cwd, maxBuffer: 512 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${args[0]} failed: ${stderr.trim() || err.message}`, { cause: err }))
        else resolve(stdout)
      })
    })

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
// git-describe reports these when no tag is reachable, or when the tag's commit has no parent.
const NO_TAG = /No names found|No tags can describe|Not a valid object name|unknown revision/i

const ref = (tag: string): string => `refs/tags/${tag}`
const escapeGlob = (text: string): string => text.replace(/[\\*?[\]]/g, '\\$&')

export async function tagExists(git: Git, tag: string): Promise<boolean> {
  return git(['rev-parse', '--verify', '--quiet', `${ref(tag)}^{commit}`]).then(
    () => true,
    () => false
  )
}

export async function isShallow(git: Git): Promise<boolean> {
  return (await git(['rev-parse', '--is-shallow-repository'])).trim() === 'true'
}

/** A SemVer pre-release has a hyphen straight after the patch number (https://semver.org/#spec-item-9). */
export const isPrerelease = (version: string): boolean => /^\d+\.\d+\.\d+-/.test(version)

/** A complete SemVer version, with optional pre-release and build metadata (https://semver.org/#semantic-versioning-200). */
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * A glob for the tags that share this tag's format, found by swapping the version for a wildcard:
 * tag `pkg-v1.2.3` with version `1.2.3` gives `pkg-v*.*.*`. The two dots keep out partial tags such as
 * `v1` and `v1.2`, which PSR's `add_partial_tags` creates. The lengths locate the version inside a matching tag.
 */
export function tagGlobs(tag: string, version: string): { all: string; prefixLength: number; suffixLength: number } | undefined {
  const at = version ? tag.lastIndexOf(version) : -1
  if (at < 0) return undefined
  const suffixLength = tag.length - at - version.length
  const prefix = escapeGlob(tag.slice(0, at))
  const suffix = escapeGlob(tag.slice(at + version.length))
  return { all: `${prefix}*.*.*${suffix}`, prefixLength: at, suffixLength }
}

/**
 * The nearest tag of the same format in the history before `tag`. A full release skips pre-release
 * tags, so its range covers everything since the last full release. Undefined on a first release.
 * Tags are classified by the version inside them, so a hyphen in build metadata (`1.0.0+build-5`) is
 * not mistaken for a pre-release. When `version` is itself a SemVer version, a match whose version part
 * is not one, such as another package's `vlib-9.0.0` matching `v*.*.*`, is skipped too.
 */
export async function previousTag(git: Git, tag: string, version: string): Promise<string | undefined> {
  const globs = tagGlobs(tag, version)
  if (!globs) {
    throw new Error(`Tag '${tag}' does not contain version '${version}', so the previous tag can't be derived. Set 'previous-tag'.`)
  }
  const strict = VERSION.test(version)
  const skipped: string[] = []
  for (;;) {
    let found: string
    try {
      const args = ['describe', '--tags', '--abbrev=0', `--match=${globs.all}`, ...skipped.map(name => `--exclude=${escapeGlob(name)}`)]
      found = (await git([...args, `${ref(tag)}^`])).trim()
    } catch (err) {
      if (NO_TAG.test((err as Error).message)) return undefined
      throw err
    }
    const foundVersion = found.slice(globs.prefixLength, found.length - globs.suffixLength)
    const skip = (strict && !VERSION.test(foundVersion)) || (!isPrerelease(version) && isPrerelease(foundVersion))
    if (!skip) return found
    skipped.push(found)
  }
}

/** Commits reachable from `tag` but not from `base`, newest first, limited to `paths` when given. */
export async function listCommits(git: Git, base: string | undefined, tag: string, paths: string[] = []): Promise<Commit[]> {
  const range = base ? `${ref(base)}..${ref(tag)}` : ref(tag)
  const out = await git(['log', '-z', '--format=%H%x1f%B', range, '--', ...paths])
  return out
    .split('\0')
    .filter(entry => entry.trim())
    .map(entry => {
      const at = entry.indexOf('\x1f')
      const sha = entry.slice(0, at).trim()
      if (!SHA.test(sha)) throw new Error(`Unexpected git log output: '${sha.slice(0, 64)}' is not a commit SHA.`)
      return { sha, message: entry.slice(at + 1).trim() }
    })
}
