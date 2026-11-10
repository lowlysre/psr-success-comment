import type { Status } from './release.ts'

export type Tone = 'ok' | 'busy' | 'warn' | 'fail' | 'idle'

const ANSI: Record<Tone, string> = { ok: '32', busy: '94', warn: '33', fail: '31', idle: '90' }
const SUMMARY_DOT: Record<Tone, string> = { ok: '🟢', busy: '🔵', warn: '🟡', fail: '🔴', idle: '⚪' }

const TONES: Record<Status, Tone> = {
  commented: 'ok',
  'already-commented': 'idle',
  'would-comment': 'busy',
  filtered: 'idle',
  forbidden: 'warn',
  'not-found': 'warn',
  failed: 'fail'
}

export const paint = (code: string, text: string): string => `\u001b[${code}m${text}\u001b[0m`
export const dim = (text: string): string => paint('2', text)

export const toneOf = (status: Status): Tone => TONES[status]

// A colored "● status" for the step log.
export const logStatus = (status: Status): string => paint(ANSI[toneOf(status)], `● ${status}`)

// A "🟢 status" for the job summary, which renders markdown and ignores ANSI codes.
export const summaryStatus = (status: Status): string => `${SUMMARY_DOT[toneOf(status)]} ${status}`

export const escapeHtml = (text: string): string => text.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`)

export const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`
