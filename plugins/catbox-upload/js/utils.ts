import { ToastActionCreators } from '@valenced/discord/actions'

export const MiB = 1024 * 1024

export interface Log {
	log(...args: unknown[]): void
	warn(...args: unknown[]): void
	error(...args: unknown[]): void
}

const MAX_LOG_ENTRIES = 50
const logEntries: string[] = []
let logSink: Log = console

// Keeps recent lines in memory so they can be copied from the settings page without logcat.
function record(level: keyof Log, args: unknown[]) {
	const time = new Date().toISOString().slice(11, 19)
	logEntries.push(`${time} ${level.toUpperCase()} ${args.map(describe).join(' ')}`)
	if (logEntries.length > MAX_LOG_ENTRIES) logEntries.shift()
	try {
		logSink[level](...args)
	} catch {}
}

export const log: Log = {
	log: (...args) => record('log', args),
	warn: (...args) => record('warn', args),
	error: (...args) => record('error', args),
}

export function setLog(value: Log | undefined) {
	logSink = value ?? console
}

export function getLogEntries(): string[] {
	return logEntries.slice()
}

function describe(value: unknown): string {
	if (typeof value === 'string') return value
	if (value instanceof Error || (value && typeof value === 'object')) return errorMessage(value)
	return String(value)
}

export type ToastVariant = 'default' | 'success' | 'critical'

export function toast(key: string, text: string, variant: ToastVariant = 'default') {
	try {
		ToastActionCreators.open(key, { text, variant })
	} catch {
		// Discord builds before 350204 only have the single-object form.
		try {
			;(ToastActionCreators as any).open({ key, content: text })
		} catch (e) {
			log.warn('Could not show toast', e)
		}
	}
}

export function formatBytes(bytes: number, decimals = 2): string {
	if (!+bytes) return '0 Bytes'
	const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB']
	const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), sizes.length - 1)
	return `${Number.parseFloat((bytes / 1024 ** i).toFixed(decimals))} ${sizes[i]}`
}

export function roundDuration(hours: number): 1 | 12 | 24 | 72 {
	if (hours <= 3) return 1
	if (hours <= 15) return 12
	if (hours <= 27) return 24
	return 72
}

/** Parses `12`, `12h`, `3d` and similar into hours. */
export function parseHours(input: unknown): number | undefined {
	const match = /^(\d+(?:\.\d+)?)\s*(h|hrs?|hours?|d|days?)?$/i.exec(String(input ?? '').trim())
	if (!match) return
	const hours = Number(match[1]) * (match[2]?.[0]?.toLowerCase() === 'd' ? 24 : 1)
	return hours > 0 && Number.isFinite(hours) ? hours : undefined
}

export function errorMessage(e: unknown): string {
	if (e instanceof Error) return e.message || e.name
	if (e && typeof e === 'object') {
		// Discord's HTTP client rejects with the response: { status, body: { message, code } }.
		const { status, body, message } = e as any
		const detail = body?.message ?? message
		if (status || detail)
			return [status && `HTTP ${status}`, detail, body?.code && `(code ${body.code})`].filter(Boolean).join(' ')
		try {
			return snippet(JSON.stringify(e), 300)
		} catch {}
	}
	return String(e)
}

/** Makes response bodies (sometimes whole HTML pages) short enough for a toast. */
export function snippet(text: unknown, max = 160): string {
	const flat = String(text ?? '')
		.replace(/<[^>]*>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Splits text on line boundaries into chunks of at most `max` characters. */
export function chunkLines(text: string, max = 2000): string[] {
	const pieces: string[] = []
	for (const line of text.split('\n')) {
		if (line.length <= max) pieces.push(line)
		else for (let i = 0; i < line.length; i += max) pieces.push(line.slice(i, i + max))
	}

	const chunks: string[] = []
	let current: string | undefined
	for (const piece of pieces) {
		if (current === undefined) current = piece
		else if (current.length + 1 + piece.length <= max) current += `\n${piece}`
		else {
			chunks.push(current)
			current = piece
		}
	}
	if (current) chunks.push(current)
	return chunks.filter(chunk => chunk.trim())
}
