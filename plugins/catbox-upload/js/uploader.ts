import { Stores } from '@valenced/discord/flux'
import { Clipboard } from '@valenced/externals/react-native-clipboard'
import { getModules, lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { before, instead } from '@valenced/patcher'
import { HOSTS, MAX_BYTES, planHosts, type UploadFile, uploadTo } from './hosts'
import { type Host, type LitterboxTime, readSettings, type Settings } from './settings'
import { chunkLines, errorMessage, formatBytes, log, MiB, toast } from './utils'

export type Cleanup = (...fns: Array<() => unknown>) => void
type AnyFunction = (...args: any[]) => any

export interface UploadOverride {
	host: Host
	duration: LitterboxTime
}

interface Batch {
	pending: number
	links: string[]
	failed: number
	lastError?: string
	override?: UploadOverride
	timer?: ReturnType<typeof setTimeout>
}

interface Job {
	batch: Batch
	channelId: string
	size: number
	file: UploadFile
	plan: Host[]
	time: LitterboxTime
	settings: Settings
}

const FLUSH_DELAY = 750
const MAX_MESSAGE_LENGTH = 2000

// One batch per channel, so several files attached to one message become one link message.
const batches = new Map<string, Batch>()
const queuedInserts = new Map<string, string>()
let nextOverride: UploadOverride | undefined
let MessageActions: any
let sendingOwnMessage = false
let uploadCount = 0

export function setNextUploadOverride(override: UploadOverride) {
	nextOverride = override
}

export function resetUploaderState() {
	for (const batch of batches.values()) if (batch.timer !== undefined) clearTimeout(batch.timer)
	batches.clear()
	queuedInserts.clear()
	nextOverride = undefined
	MessageActions = undefined
	sendingOwnMessage = false
	uploadCount = 0
}

export function patchUploader(cleanup: Cleanup) {
	cleanup(
		getModules(withProps('CloudUpload'), mod => {
			const proto = mod?.CloudUpload?.prototype
			if (typeof proto?.reactNativeCompressAndExtractData !== 'function') {
				log.warn('CloudUpload.prototype.reactNativeCompressAndExtractData not found, uploads are left alone')
				return
			}

			cleanup(
				instead(
					proto,
					'reactNativeCompressAndExtractData',
					function (this: any, args: any[], original: AnyFunction) {
						let job: Job | undefined
						try {
							job = prepareJob(this)
						} catch (e) {
							log.error('Could not inspect upload, passing it to Discord', e)
						}
						return job ? runJob(this, job) : original.apply(this, args)
					},
				),
			)
			log.log('Hooked CloudUpload')
		}),
	)
}

export function patchMessageSender(cleanup: Cleanup) {
	cleanup(
		getModules(withProps('sendMessage', 'editMessage'), mod => {
			MessageActions = mod
			log.log('Hooked sendMessage, module keys:', moduleKeys(mod))
			cleanup(
				before(mod, 'sendMessage', args => {
					const [channelId, message] = args
					const queued = queuedInserts.get(channelId)
					if (sendingOwnMessage || queued === undefined || !message || typeof message !== 'object') return args

					queuedInserts.delete(channelId)
					message.content = message.content ? `${message.content}\n${queued}` : queued
					return args
				}),
			)
		}),
	)
}

/** Returns undefined when Discord should handle the upload itself. */
function prepareJob(upload: any): Job | undefined {
	const settings = readSettings()
	const size = Number(upload.preCompressionSize ?? upload.currentSize ?? 0) || 0
	if (!settings.alwaysUpload && size <= (Number(settings.limitMb) || 10) * MiB) return

	const uri =
		upload.item?.originalUri ??
		upload.item?.uri ??
		upload.uri ??
		upload.fileUri ??
		upload.path ??
		upload.sourceURL
	if (!uri) return

	const channelId = upload.channelId ?? selectedChannelId()
	if (!channelId) return

	let batch = batches.get(channelId)
	const pendingOverride = batch?.pending ? batch.override : (nextOverride ?? batch?.override)
	if (!planHosts(size, pendingOverride?.host ?? settings.host, settings.fallback).length) {
		toast(
			'catbox-upload-too-large',
			`${formatBytes(size)} is too large for any host (max ${formatBytes(MAX_BYTES)})`,
			'critical',
		)
		return
	}

	if (!batch) batches.set(channelId, (batch = { pending: 0, links: [], failed: 0 }))
	if (batch.timer !== undefined) {
		clearTimeout(batch.timer)
		batch.timer = undefined
	}
	if (batch.pending++ === 0) {
		batch.override = nextOverride ?? batch.override
		nextOverride = undefined
	}

	// Carried over from the Revenge plugin: keeps Discord from rejecting the oversized
	// upload while we handle it.
	upload.preCompressionSize = 1337

	return {
		batch,
		channelId,
		size,
		file: {
			uri: String(uri),
			name: String(upload.filename ?? upload.item?.filename ?? 'upload'),
			type: String(upload.mimeType ?? upload.item?.mimeType ?? 'application/octet-stream'),
		},
		plan: planHosts(size, batch.override?.host ?? settings.host, settings.fallback),
		time: batch.override?.duration ?? settings.litterboxTime,
		settings,
	}
}

async function runJob(upload: any, job: Job): Promise<null> {
	const { batch, channelId, settings } = job
	const toastKey = `catbox-upload-${++uploadCount}`
	let link: string | undefined
	let lastError: string | undefined

	for (const host of job.plan) {
		try {
			link = await uploadWithProgress(host, job, toastKey)
			break
		} catch (e) {
			lastError = `${HOSTS[host].name}: ${errorMessage(e)}`
			log.warn(`Upload of ${job.file.name} to ${HOSTS[host].name} failed`, e)
		}
	}

	try {
		upload.setStatus?.('CANCELED')
	} catch (e) {
		log.warn('Could not cancel the Discord upload', e)
	}

	// The plugin was stopped while this was uploading.
	if (batches.get(channelId) !== batch) {
		if (link) log.log(`Uploaded ${job.file.name} after the plugin stopped: ${link}`)
		return null
	}

	if (link) {
		log.log(`Uploaded ${job.file.name} (${formatBytes(job.size)}): ${link}`)
		batch.links.push(formatLink(job.file.name, link, settings.linkStyle === 'name'))
	} else {
		batch.failed++
		batch.lastError = lastError ?? 'no host available'
	}

	if (--batch.pending === 0) batch.timer = setTimeout(() => flush(channelId), FLUSH_DELAY)
	return null
}

function uploadWithProgress(host: Host, job: Job, toastKey: string) {
	const { settings } = job
	const label = `Uploading ${job.size ? `${formatBytes(job.size)} ` : ''}to ${HOSTS[host].name}…`
	let step = 0
	toast(toastKey, label)

	return uploadTo(host, job.file, {
		time: job.time,
		userhash: settings.userhash,
		proxyUrl: settings.proxyUrl,
		proxyLinks: settings.proxyLinks,
		onProgress(fraction) {
			const next = Math.min(4, Math.floor(fraction * 4))
			if (next <= step) return
			step = next
			toast(toastKey, `${label} ${next * 25}%`)
		},
	})
}

function formatLink(name: string, url: string, masked: boolean) {
	if (!masked) return url
	return `[${name.replace(/[[\]]/g, '') || 'file'}](${url})`
}

function flush(channelId: string) {
	const batch = batches.get(channelId)
	if (!batch || batch.pending > 0) return
	batches.delete(channelId)

	// Nothing uploaded: keep Discord's failed message so the user still has their text.
	if (!batch.links.length) {
		toast('catbox-upload-result', `Upload failed: ${batch.lastError ?? 'unknown error'}`, 'critical')
		return
	}

	const text = [takeFailedMessageText(channelId), ...batch.links].filter(Boolean).join('\n')
	const failedNote = batch.failed ? ` ${batch.failed} file(s) failed: ${batch.lastError}` : ''
	deliver(channelId, text, readSettings().afterUpload, batch.links.length > 1).then(
		({ message, ok }) =>
			toast('catbox-upload-result', `${message}${failedNote}`, ok && !failedNote ? 'success' : 'critical'),
		e => {
			log.error('Could not deliver the upload link', text, e)
			toast(
				'catbox-upload-result',
				`Uploaded, but the link could not be delivered: ${errorMessage(e)}`,
				'critical',
			)
		},
	)
}

/** Deletes Discord's failed copies of the message and returns their text to go with the links. */
function takeFailedMessageText(channelId: string) {
	return deleteFailedMessages(channelId, () => true).join('\n')
}

/** Deletes failed pending messages that match, and returns their distinct non-empty contents. */
function deleteFailedMessages(channelId: string, matches: (content: string) => boolean) {
	const contents: string[] = []
	try {
		const PendingMessages = lookupModule(
			withProps('getPendingMessages', 'deletePendingMessage'),
		)[0] as any
		const pending = PendingMessages?.getPendingMessages?.(channelId)
		if (!pending) return contents

		const entries: Iterable<[string, any]> = pending instanceof Map ? pending : Object.entries(pending)
		for (const [id, message] of entries) {
			if (message?.state !== 'FAILED') continue
			const content = typeof message.content === 'string' ? message.content.trim() : ''
			if (!matches(content)) continue
			if (content && !contents.includes(content)) contents.push(content)
			PendingMessages.deletePendingMessage(channelId, id)
		}
	} catch (e) {
		log.warn('Could not clean up failed messages', e)
	}
	return contents
}

interface Delivery {
	message: string
	ok: boolean
}

async function deliver(
	channelId: string,
	text: string,
	mode: Settings['afterUpload'],
	plural: boolean,
): Promise<Delivery> {
	const noun = plural ? 'Links' : 'Link'

	if (mode === 'copy') {
		Clipboard.setString(text)
		return { message: `${noun} copied to clipboard.`, ok: true }
	}

	if (mode === 'insert') {
		// Without the sendMessage hook the queued link would never be added.
		if (!MessageActions) {
			Clipboard.setString(text)
			return {
				message: `Couldn't hook message sending, ${noun.toLowerCase()} copied to clipboard instead.`,
				ok: false,
			}
		}
		const queued = queuedInserts.get(channelId)
		queuedInserts.set(channelId, queued ? `${queued}\n${text}` : text)
		return { message: `${noun} will be added to your next message.`, ok: true }
	}

	const chunks = chunkLines(text, MAX_MESSAGE_LENGTH)
	for (let i = 0; i < chunks.length; i++) {
		const problem = await sendChunk(channelId, chunks[i]!)
		if (problem) {
			Clipboard.setString(chunks.slice(i).join('\n'))
			return {
				message: `Couldn't send the ${noun.toLowerCase()}, copied to clipboard instead. ${problem}`,
				ok: false,
			}
		}
	}
	return { message: `${noun} sent.`, ok: true }
}

/** Sends through Discord's message actions, then its REST client. Returns what went wrong, if anything. */
async function sendChunk(channelId: string, content: string): Promise<string | undefined> {
	const problems: string[] = []

	const actions = getMessageActions()
	if (typeof actions?.sendMessage === 'function') {
		try {
			let result: unknown
			sendingOwnMessage = true
			try {
				result = actions.sendMessage(channelId, {
					content,
					tts: false,
					invalidEmojis: [],
					validNonShortcutEmojis: [],
				})
			} finally {
				sendingOwnMessage = false
			}
			await result
			return
		} catch (e) {
			problems.push(`sendMessage: ${errorMessage(e)}`)
			log.error('sendMessage failed, trying the REST API. Module keys:', moduleKeys(actions), e)
		}
	} else problems.push('sendMessage: module not found')

	const http = getHttp()
	if (typeof http?.post === 'function') {
		try {
			const response = await http.post({ url: `/channels/${channelId}/messages`, body: { content, tts: false } })
			if (response?.ok === false) throw response
			// A rejected sendMessage leaves a failed copy in the chat next to the real message.
			deleteFailedMessages(channelId, failed => failed === content.trim())
			log.log('Sent the link through the REST API')
			return
		} catch (e) {
			problems.push(`REST: ${errorMessage(e)}`)
			log.error('REST send failed', e)
		}
	} else problems.push('REST: HTTP client not found')

	return problems.join('; ')
}

function getMessageActions() {
	return (
		MessageActions ??
		lookupModule(withProps('sendMessage', 'editMessage'))[0] ??
		lookupModule(withProps('sendMessage'))[0]
	)
}

// ../discord_common/js/packages/http-utils/HTTPUtils.tsx, the same module Valenced's no-track plugin patches.
function getHttp() {
	const HTTPUtils = lookupModule(withProps('HTTP', 'post'))[0] as any
	return HTTPUtils?.HTTP ?? HTTPUtils
}

function moduleKeys(mod: unknown) {
	try {
		return Object.keys(mod as object).slice(0, 25).join(',')
	} catch {
		return '?'
	}
}

function selectedChannelId(): string | undefined {
	try {
		return (Stores.SelectedChannelStore as any)?.getChannelId?.()
	} catch {
		return undefined
	}
}
