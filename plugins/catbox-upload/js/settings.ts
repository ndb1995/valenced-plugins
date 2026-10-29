import type { JsonStorage } from '@valenced/json-storage'

export type Host = 'catbox' | 'litterbox' | 'pomf'
export type LitterboxTime = '1h' | '12h' | '24h' | '72h'
export type AfterUpload = 'send' | 'insert' | 'copy'

export type Settings = {
	host: Host
	litterboxTime: LitterboxTime
	limitMb: 10 | 50 | 100 | 500
	alwaysUpload: boolean
	fallback: boolean
	afterUpload: AfterUpload
	maskedLinks: boolean
	userhash: string
	command: boolean
	proxyUrl: string
	proxyLinks: boolean
}

export const DEFAULTS: Settings = {
	host: 'catbox',
	litterboxTime: '72h',
	limitMb: 10,
	alwaysUpload: false,
	fallback: true,
	afterUpload: 'send',
	maskedLinks: true,
	userhash: '',
	command: true,
	proxyUrl: '',
	proxyLinks: false,
}

let storage: JsonStorage<Settings> | undefined

export function bindStorage(value: JsonStorage<Settings> | undefined) {
	storage = value
}

// Stored files can predate newer keys, so always layer them over the defaults.
export function readSettings(): Settings {
	return { ...DEFAULTS, ...(storage?.cache as Partial<Settings> | undefined) }
}
