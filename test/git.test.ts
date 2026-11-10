import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { gitIn, isPrerelease, isShallow, listCommits, previousTag, tagExists, tagGlobs, type Git } from '../src/git.ts'
import { makeRepo, type TestRepo } from './helpers.ts'

describe('tagGlobs', () => {
  it('swaps the version for a wildcard, keeping the prefix and suffix', () => {
    assert.deepEqual(tagGlobs('v1.2.3', '1.2.3'), { all: 'v*.*.*', prerelease: 'v*.*.*-*' })
    assert.deepEqual(tagGlobs('pkg-v1.2.3', '1.2.3'), { all: 'pkg-v*.*.*', prerelease: 'pkg-v*.*.*-*' })
    assert.deepEqual(tagGlobs('1.2.3-pkg', '1.2.3'), { all: '*.*.*-pkg', prerelease: '*.*.*-*-pkg' })
  })

  it('escapes glob characters in the tag', () => {
    assert.deepEqual(tagGlobs('a[b]*v1.0.0', '1.0.0'), { all: 'a\\[b\\]\\*v*.*.*', prerelease: 'a\\[b\\]\\*v*.*.*-*' })
  })

  it('returns undefined when the tag does not contain the version', () => {
    assert.equal(tagGlobs('latest', '1.2.3'), undefined)
    assert.equal(tagGlobs('v1.2.3', ''), undefined)
  })
})

describe('isPrerelease', () => {
  it('detects a SemVer pre-release', () => {
    assert.equal(isPrerelease('1.0.0-rc.1'), true)
    assert.equal(isPrerelease('1.0.0'), false)
    assert.equal(isPrerelease('1.0.0+build-5'), false)
  })
})

describe('git history', () => {
  let repo: TestRepo
  let git: Git
  const sha: Record<string, string> = {}

  // main: a - b(v1.0.0) - c(v1.1.0-rc.1) - d(pkg-v0.1.0) - e(v1.1.0-rc.2) - f(v1.1.0, v1) - g(pkg-v0.2.0)
  before(() => {
    repo = makeRepo()
    git = gitIn(repo.dir)
    sha.a = repo.commit('chore: start')
    sha.b = repo.commit('feat: one\n\nFixes #1')
    repo.tag('v1.0.0')
    sha.c = repo.commit('feat: two', 'pkg/two.txt')
    repo.tag('v1.1.0-rc.1')
    sha.d = repo.commit('fix: three')
    repo.tag('pkg-v0.1.0')
    sha.e = repo.commit('fix: four', 'pkg/four.txt')
    repo.tag('v1.1.0-rc.2')
    sha.f = repo.commit('fix: five')
    repo.tag('v1.1.0')
    repo.tag('v1')
    sha.g = repo.commit('fix: six', 'pkg/six.txt')
    repo.tag('pkg-v0.2.0')
  })
  after(() => repo.remove())

  it('finds tags, and not branches or missing names', async () => {
    assert.equal(await tagExists(git, 'v1.0.0'), true)
    assert.equal(await tagExists(git, 'main'), false)
    assert.equal(await tagExists(git, 'v9.9.9'), false)
    assert.equal(await tagExists(git, '--help'), false)
  })

  it('reports a full clone as not shallow', async () => {
    assert.equal(await isShallow(git), false)
  })

  it('compares a full release with the last full release, skipping pre-releases', async () => {
    assert.equal(await previousTag(git, 'v1.1.0', '1.1.0'), 'v1.0.0')
  })

  it('compares a pre-release with the nearest tag, pre-release or not', async () => {
    assert.equal(await previousTag(git, 'v1.1.0-rc.2', '1.1.0-rc.2'), 'v1.1.0-rc.1')
    assert.equal(await previousTag(git, 'v1.1.0-rc.1', '1.1.0-rc.1'), 'v1.0.0')
  })

  it('ignores partial version tags such as v1 and v1.1', async () => {
    repo.git('tag', '--force', 'v1.1', 'v1.1.0')
    const next = repo.commit('fix: seven')
    repo.tag('v1.1.1')
    assert.equal(await previousTag(git, 'v1.1.1', '1.1.1'), 'v1.1.0')
    repo.git('tag', '--delete', 'v1.1.1')
    repo.git('reset', '--quiet', '--hard', `${next}^`)
  })

  it('only considers tags with the same format', async () => {
    assert.equal(await previousTag(git, 'pkg-v0.2.0', '0.2.0'), 'pkg-v0.1.0')
  })

  it('returns undefined for a first release', async () => {
    assert.equal(await previousTag(git, 'v1.0.0', '1.0.0'), undefined)
    assert.equal(await previousTag(git, 'pkg-v0.1.0', '0.1.0'), undefined)
  })

  it('returns undefined when the tag is on the root commit', async () => {
    repo.git('tag', 'root-v0.0.1', sha.a as string)
    assert.equal(await previousTag(git, 'root-v0.0.1', '0.0.1'), undefined)
  })

  it('fails when the tag does not contain the version', async () => {
    await assert.rejects(previousTag(git, 'v1.1.0', '2.0.0'), /does not contain version '2\.0\.0'.*Set 'previous-tag'/)
  })

  it('surfaces git failures other than a missing tag', async () => {
    const broken: Git = () => Promise.reject(new Error('git describe failed: fatal: not a git repository'))
    await assert.rejects(previousTag(broken, 'v1.1.0', '1.1.0'), /not a git repository/)
  })

  it('lists the commits between two tags, newest first, with full messages', async () => {
    const commits = await listCommits(git, 'v1.0.0', 'v1.1.0')
    assert.deepEqual(
      commits.map(commit => commit.sha),
      [sha.f, sha.e, sha.d, sha.c]
    )
    assert.equal(commits[0]?.message, 'fix: five')
  })

  it('lists every commit up to the tag when there is no base', async () => {
    const commits = await listCommits(git, undefined, 'v1.0.0')
    assert.deepEqual(
      commits.map(commit => commit.sha),
      [sha.b, sha.a]
    )
    assert.equal(commits[0]?.message, 'feat: one\n\nFixes #1')
  })

  it('limits commits to the given paths', async () => {
    const commits = await listCommits(git, 'v1.0.0', 'pkg-v0.2.0', ['pkg'])
    assert.deepEqual(
      commits.map(commit => commit.sha),
      [sha.g, sha.e, sha.c]
    )
  })

  it('returns no commits for an empty range', async () => {
    assert.deepEqual(await listCommits(git, 'v1.1.0', 'v1'), [])
  })

  it('reports git errors with the command and stderr', async () => {
    await assert.rejects(listCommits(git, 'nope', 'v1.1.0'), /git log failed: .*nope/s)
  })

  it('rejects output that is not a commit SHA', async () => {
    const odd: Git = () => Promise.resolve('not-a-sha\x1fmessage\0')
    await assert.rejects(listCommits(odd, undefined, 'v1.0.0'), /is not a commit SHA/)
  })

  it('detects a shallow clone', async () => {
    const shallow = makeRepo()
    try {
      shallow.git('fetch', '--quiet', '--depth=1', `file://${repo.dir.replace(/\\/g, '/')}`, 'main')
      assert.equal(await isShallow(gitIn(shallow.dir)), true)
    } finally {
      shallow.remove()
    }
  })
})
