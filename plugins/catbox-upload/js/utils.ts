import { ToastActionCreators } from '@valenced/discord/actions'

export const MiB = 1024 * 1024

export interface Log {
	log(...args: unknown[]): void
	warn(...args: unknown[]): void
	error(...args: unknown[]): void
}

export let log: Log = console

export function setLog(value: Log | undefined) {
	log = value ?? console
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
	return e instanceof Error ? e.message : String(e)
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
