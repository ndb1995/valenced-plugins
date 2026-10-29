import type { Host, LitterboxTime } from './settings'
import { MiB, snippet } from './utils'

export interface HostInfo {
	name: string
	maxBytes: number
}

export const HOSTS: Record<Host, HostInfo> = {
	catbox: { name: 'Catbox', maxBytes: 200 * MiB },
	litterbox: { name: 'Litterbox', maxBytes: 1024 * MiB },
	pomf: { name: 'Pomf', maxBytes: 1024 * MiB },
}

export const HOST_ORDER: Host[] = ['catbox', 'litterbox', 'pomf']

export const MAX_BYTES = Math.max(...HOST_ORDER.map(host => HOSTS[host].maxBytes))

/** React Native's FormData file part. */
export interface UploadFile {
	uri: string
	name: string
	type: string
}

export interface UploadOptions {
	time: LitterboxTime
	userhash: string
	proxyUrl: string
	proxyLinks: boolean
	onProgress?: (fraction: number) => void
}

/** Preferred host first, then the rest in default order, skipping any the file is too big for. */
export function planHosts(size: number, preferred: Host, fallback: boolean): Host[] {
	const plan = [preferred, ...HOST_ORDER.filter(host => host !== preferred)].filter(
		host => size <= HOSTS[host].maxBytes,
	)
	return fallback ? plan : plan.slice(0, 1)
}

export function normalizeProxyUrl(url: string): string {
	return url.trim().replace(/\/+$/, '')
}

export function uploadTo(host: Host, file: UploadFile, options: UploadOptions): Promise<string> {
	const proxyUrl = normalizeProxyUrl(options.proxyUrl)
	if (proxyUrl) return uploadViaProxy(proxyUrl, host, file, options)

	switch (host) {
		case 'catbox':
			return uploadToCatbox(file, options)
		case 'litterbox':
			return uploadToLitterbox(file, options)
		case 'pomf':
			return uploadToPomf(file, options)
	}
}

async function uploadToCatbox(file: UploadFile, options: UploadOptions) {
	const form = new FormData()
	form.append('reqtype', 'fileupload')
	const userhash = options.userhash.trim()
	if (userhash) form.append('userhash', userhash)
	form.append('fileToUpload', file as any)
	return expectUrl(await post('https://catbox.moe/user/api.php', form, options.onProgress))
}

async function uploadToLitterbox(file: UploadFile, options: UploadOptions) {
	const form = new FormData()
	form.append('reqtype', 'fileupload')
	form.append('time', options.time)
	form.append('fileToUpload', file as any)
	return expectUrl(
		await post('https://litterbox.catbox.moe/resources/internals/api.php', form, options.onProgress),
	)
}

async function uploadToPomf(file: UploadFile, options: UploadOptions) {
	const form = new FormData()
	form.append('files[]', file as any)
	const json = parseJson(await post('https://pomf.lain.la/upload.php', form, options.onProgress))
	if (!json?.success) throw new Error(String(json?.description ?? json?.error ?? 'Upload rejected'))
	const url = json.files?.[0]?.url
	if (typeof url !== 'string' || !url) throw new Error('No URL in response')
	return url
}

async function uploadViaProxy(proxyUrl: string, host: Host, file: UploadFile, options: UploadOptions) {
	const form = new FormData()
	form.append('destination', host)
	form.append('time', options.time)
	const userhash = options.userhash.trim()
	if (userhash) form.append('userhash', userhash)
	form.append('file', file as any)

	const json = parseJson(await post(`${proxyUrl}/direct`, form, options.onProgress))
	const url = json?.url
	if (typeof url !== 'string' || !url) throw new Error(String(json?.error ?? 'No URL in proxy response'))
	if (!options.proxyLinks) return url

	// React Native's URL has no pathname, so take the last path segment by hand.
	const fileName = url.split(/[?#]/)[0]!.split('/').pop()
	return fileName ? `${proxyUrl}/${host}/${fileName}` : url
}

function expectUrl(text: string) {
	const url = text.trim()
	if (!url.startsWith('https://')) throw new Error(snippet(url) || 'Empty response')
	return url
}

function parseJson(text: string): any {
	try {
		return JSON.parse(text)
	} catch {
		throw new Error(`Unexpected response: ${snippet(text) || 'empty'}`)
	}
}

// XMLHttpRequest rather than fetch, because only XHR reports upload progress.
function post(url: string, body: FormData, onProgress?: (fraction: number) => void) {
	return new Promise<string>((resolve, reject) => {
		const xhr = new XMLHttpRequest()
		xhr.open('POST', url)
		xhr.onload = () => {
			const text = String(xhr.responseText ?? '')
			if (xhr.status >= 200 && xhr.status < 300) resolve(text)
			else reject(new Error(`HTTP ${xhr.status}${text ? `: ${snippet(text)}` : ''}`))
		}
		xhr.onerror = () => reject(new Error(`Network error while contacting ${hostOf(url)}`))
		xhr.ontimeout = () => reject(new Error(`Timed out while contacting ${hostOf(url)}`))
		if (onProgress && xhr.upload)
			xhr.upload.onprogress = event => {
				if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total)
			}
		xhr.send(body)
	})
}

function hostOf(url: string) {
	return url.replace(/^[a-z]+:\/\//i, '').split('/')[0]
}
