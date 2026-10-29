// Runs the built bundle (npm run build first) against a mocked Valenced and Discord.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { strFromU8, unzipSync } from 'fflate'

const code = readFileSync(new URL('../plugins/catbox-upload/build/js/index.js', import.meta.url), 'utf8')
const MiB = 1024 * 1024

const CATBOX = 'https://catbox.moe/user/api.php'
const LITTERBOX = 'https://litterbox.catbox.moe/resources/internals/api.php'
const POMF = 'https://pomf.lain.la/upload.php'

const load = valenced => new Function('valenced', 'plugin', `return ${code}`)(valenced, opts => opts).default

const settle = async (rounds = 5) => {
	for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve))
}

const element = (type, props) => ({ type, props })

const findAll = (node, predicate, found = []) => {
	if (Array.isArray(node)) for (const child of node) findAll(child, predicate, found)
	else if (node && typeof node === 'object') {
		if (predicate(node)) found.push(node)
		findAll(node.props?.children, predicate, found)
	}
	return found
}

const fileName = form => form.fields.find(([, value]) => typeof value === 'object')?.[1]?.name

const defaultRespond = (url, form) => {
	if (url === CATBOX) return { body: `https://files.catbox.moe/${fileName(form)}` }
	if (url === LITTERBOX) return { body: `https://litter.catbox.moe/${fileName(form)}` }
	if (url === POMF) return { body: JSON.stringify({ success: true, files: [{ url: `https://pomf2.lain.la/f/${fileName(form)}` }] }) }
	return { status: 404, body: 'not found' }
}

function setup({
	settings = {},
	respond = defaultRespond,
	pendingContent = 'look at this',
	editMessage = true,
	sendMessageError,
	httpResponse = { ok: true, status: 200, body: {} },
} = {}) {
	const toasts = []
	const requests = []
	const httpRequests = []
	const clipboard = []
	const sent = []
	const deleted = []
	const originalCalls = []
	const logs = []
	const cleanups = []

	globalThis.FormData = class {
		fields = []
		append(key, value) {
			this.fields.push([key, value])
		}
	}
	globalThis.XMLHttpRequest = class {
		upload = {}
		status = 0
		responseText = ''
		open(method, url) {
			this.method = method
			this.url = url
		}
		send(form) {
			const request = { url: this.url, method: this.method, form, fields: Object.fromEntries(form.fields) }
			requests.push(request)
			const response = respond(this.url, form)
			setImmediate(() => {
				this.upload.onprogress?.({ lengthComputable: true, loaded: 30, total: 100 })
				this.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 })
				if (response.networkError) return this.onerror?.()
				this.status = response.status ?? 200
				this.responseText = response.body
				this.onload?.()
			})
		}
	}

	class CloudUpload {
		constructor(props) {
			Object.assign(this, props)
			this.statuses = []
		}
		reactNativeCompressAndExtractData(...args) {
			originalCalls.push({ upload: this, args })
			return 'original-result'
		}
		setStatus(status) {
			this.statuses.push(status)
		}
	}
	const originalCompress = CloudUpload.prototype.reactNativeCompressAndExtractData

	const pending = { c1: pendingContent === null ? {} : { m1: { id: 'm1', state: 'FAILED', content: pendingContent } } }
	const messageActions = {
		sendMessage(channelId, message, _waitForChannel, options) {
			// Current Discord reads options.nonce without defaulting options.
			if (options === undefined) throw new TypeError("Cannot read property 'nonce' of undefined")
			if (sendMessageError) {
				// Like Discord, a failed send leaves a failed copy in the chat.
				pending[channelId] ??= {}
				pending[channelId][`n${Object.keys(pending[channelId]).length}`] = { state: 'FAILED', content: message.content }
				return Promise.reject(sendMessageError)
			}
			sent.push([channelId, message])
			return Promise.resolve()
		},
		editMessage() {},
	}
	if (!editMessage) delete messageActions.editMessage
	const originalSendMessage = messageActions.sendMessage
	const commands = {
		getBuiltInCommands(type) {
			return type === 1 ? [{ id: '-1', name: 'shrug' }, { id: '-5', name: 'tableflip' }] : [{ id: '-2', name: 'other' }]
		},
	}
	const originalGetBuiltInCommands = commands.getBuiltInCommands

	const registry = [
		{ CloudUpload },
		messageActions,
		{
			getPendingMessages: channelId => pending[channelId] ?? {},
			deletePendingMessage(channelId, id) {
				deleted.push([channelId, id])
				delete pending[channelId][id]
			},
		},
		commands,
		{
			HTTP: {
				post(request) {
					httpRequests.push(request)
					return httpResponse.ok ? Promise.resolve(httpResponse) : Promise.reject(httpResponse)
				},
			},
			post() {},
		},
	]

	const valenced = {
		modules: {
			finders: {
				getModules(filter, callback) {
					const index = registry.findIndex(filter)
					if (index !== -1) callback(registry[index], index)
					return () => {}
				},
				lookupModule(filter) {
					const index = registry.findIndex(filter)
					return index === -1 ? [] : [registry[index], index]
				},
				filters: {
					withProps:
						(...props) =>
						mod =>
							mod != null && props.every(prop => prop in mod),
				},
			},
		},
		patcher: {
			before(parent, key, hook) {
				const original = parent[key]
				const patched = function (...args) {
					return original.apply(this, hook(args))
				}
				parent[key] = patched
				return () => {
					if (parent[key] === patched) parent[key] = original
				}
			},
			instead(parent, key, hook) {
				const original = parent[key]
				const patched = function (...args) {
					return hook.call(this, args, original)
				}
				parent[key] = patched
				return () => {
					if (parent[key] === patched) parent[key] = original
				}
			},
		},
		discord: {
			actions: { ToastActionCreators: { open: (key, options) => toasts.push({ key, ...options }) } },
			flux: { Stores: { SelectedChannelStore: { getChannelId: () => 'c1' } } },
			// Components render as their name, so the settings page can be inspected as plain data.
			design: { Design: new Proxy({}, { get: (_, key) => String(key) }) },
		},
		externals: { ReactNativeClipboard: { Clipboard: { setString: text => clipboard.push(text) } } },
		react: {
			React: { useState: initial => [initial, () => {}] },
			ReactNative: { ScrollView: 'ScrollView' },
			ReactJSXRuntime: { jsx: element, jsxs: element, Fragment: 'Fragment' },
		},
		components: { Page: 'Page' },
	}

	const options = load(valenced)
	const saved = []
	const jsonStorage = {
		cache: { ...settings },
		get: async () => jsonStorage.cache,
		set: async value => {
			saved.push(value)
			Object.assign(jsonStorage.cache, value)
		},
		use: () => jsonStorage.cache,
		subscribe: () => () => {},
	}
	const logger = { log: (...a) => logs.push(a), warn: (...a) => logs.push(a), error: (...a) => logs.push(a) }
	const plugin = { manifest: { name: 'Catbox Uploader', version: { nums: [1, 0, 3] } } }
	const api = { cleanup: (...fns) => cleanups.push(...fns), jsonStorage, plugin, unscoped: valenced, logger }
	options.start(api)

	const upload = (props = {}) =>
		new CloudUpload({
			channelId: 'c1',
			preCompressionSize: 50 * MiB,
			filename: 'video.mp4',
			mimeType: 'video/mp4',
			item: { originalUri: 'file:///storage/video.mp4' },
			...props,
		})

	return {
		CloudUpload,
		originalCompress,
		originalSendMessage,
		originalGetBuiltInCommands,
		messageActions,
		commands,
		pending,
		toasts,
		requests,
		httpRequests,
		clipboard,
		sent,
		deleted,
		originalCalls,
		logs,
		cleanups,
		jsonStorage,
		saved,
		options,
		api,
		upload,
		stop: () => cleanups.forEach(fn => fn()),
	}
}

// Starts an upload through the patched method and waits for the batch to flush.
async function runUpload(t, env, ...uploads) {
	const results = uploads.map(u => u.reactNativeCompressAndExtractData('arg'))
	const values = await Promise.all(results)
	t.mock.timers.tick(750)
	await settle()
	return values
}

const sendOptions = content => ({ content, tts: false, invalidEmojis: [], validNonShortcutEmojis: [] })

test('loads without touching the Valenced API', () => {
	const throwing = new Proxy(
		{},
		{
			get(_, key) {
				throw new Error(`accessed ${String(key)}`)
			},
			has(_, key) {
				throw new Error(`checked ${String(key)}`)
			},
		},
	)
	const options = load(throwing)
	assert.equal(typeof options.start, 'function')
	assert.equal(typeof options.SettingsComponent, 'function')
	assert.equal(options.jsonStorage.load, true)
	assert.equal(options.jsonStorage.default.host, 'catbox')
})

test('files under the limit go to Discord untouched', t => {
	t.mock.timers.enable({ apis: ['setTimeout'] })
	const env = setup()
	const u = env.upload({ preCompressionSize: 5 * MiB })
	assert.equal(u.reactNativeCompressAndExtractData('arg'), 'original-result')
	assert.equal(env.originalCalls.length, 1)
	assert.deepEqual(env.originalCalls[0].args, ['arg'])
	assert.equal(env.requests.length, 0)
	assert.equal(u.preCompressionSize, 5 * MiB)
})

test('a 50 MB file is uploaded to catbox and the link is sent with the caption', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] })
	const env = setup()
	const u = env.upload()
	const result = u.reactNativeCompressAndExtractData('arg')
	assert.ok(result instanceof Promise)
	assert.equal(u.preCompressionSize, 1337)

	assert.equal(await result, null)
	assert.deepEqual(u.statuses, ['CANCELED'])
	assert.equal(env.originalCalls.length, 0)
	assert.equal(env.requests.length, 1)
	const [request] = env.requests
	assert.equal(request.method, 'POST')
	assert.equal(request.url, CATBOX)
	assert.deepEqual(request.form.fields, [
		['reqtype', 'fileupload'],
		['fileToUpload', { uri: 'file:///storage/video.mp4', name: 'video.mp4', type: 'video/mp4' }],
	])
	assert.ok(env.toasts.some(toast => toast.text === 'Uploading 50 MB to Catbox…'))
	assert.ok(env.toasts.some(toast => toast.text === 'Uploading 50 MB to Catbox… 100%'))

	// Nothing is sent before the batch flushes.
	assert.equal(env.sent.length, 0)
	t.mock.timers.tick(750)
	await settle()

	assert.deepEqual(env.deleted, [['c1', 'm1']])
	assert.deepEqual(env.sent, [['c1', sendOptions('look at this\nhttps://files.catbox.moe/video.mp4')]])
	assert.equal(env.toasts.at(-1).variant, 'success')
})

test('catbox userhash is sent when set', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] })
	const env = setup({ settings: { userhash: '  abc123 ' } })
	await runUpload(t, env, env.upload())
	assert.equal(env.requests[0].fields.userhash, 'abc123')
})

test('a catbox error falls back to litterbox', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] })
	const env = setup({
		respond: (url, form) => (url === CATBOX ? { body: 'Internal error, please try again' } : defaultRespond(url, form)),
	})
	await runUpload(t, env, env.upload())

	assert.deepEqual(
		env.requests.map(r => r.url),
		[CATBOX, LITTERBOX],
	)
	assert.equal(env.requests[1].fields.time, '72h')
	assert.equal(env.requests[1].fields.reqtype, 'fileupload')
	assert.deepEqual(env.sent, [['c1', sendOptions('look at this\nhttps://litter.catbox.moe/video.mp4')]])
})

test('without fallback a failed upload keeps the failed message', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] })
	const env = setup({
		settings: { fallback: false },
		respond: (url, form) => (url === CATBOX ? { status: 503, body: '<h1>Service Unavailable</h1>' } : defaultRespond(url, form)),
	})
	const [value] = await runUpload(t, env, env.upload())

	assert.equal(value, null)
	assert.deepEqual(
		env.requests.map(r => r.url),
		[CATBOX],
	)
	assert.equal(env.sent.length, 0)
	assert.equal(env.deleted.length, 0)
	assert.ok(env.pending.c1.m1)
	const last = env.toasts.at(-1)
	assert.equal(last.variant, 'critical')
	assert.equal(last.text, 'Upload failed: Catbox: HTTP 503: Service Unavailable')
})

test('files too big for catbox skip it', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] })
	const env = setup({ settings: { host: 'catbox' } })
	await runUpload(t, env, env.upload({ preCompressionSize: 300 * MiB }))
	assert.deepEqual(
		env.requests.map(r => r.url),
		[LITTERBOX],
	)
	assert.ok(env.toasts.some(toast => toast.text === 'Uploading 300 MB to Litterbox…'))
	assert.equal(env.sent.length, 1)
})

test('files too big for every host go to Discord with a warning', t => {
	t.mock.timers.enable({ apis: ['setTimeout'] })
	const env = setup()
	const u = env.upload({ preCompressionSize: 2048 * MiB })
	assert.equal(u.reactNativeCompressAndExtractData('arg'), 'original-result')
	assert.equal(env.requests.length, 0)
	assert.equal(env.toasts.at(-1).variant, 'critical')
	assert.match(env.toasts.at(-1).text, /too large for any host \(max 1 GB\)/)
})

test('pomf uploads use files[] and read the JSON response', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] })
	const env = setup({ settings: { host: 'pomf' } })
	await runUpload(t, env, env.upload())
	assert.equal(env.requests[0].url, POMF)
	assert.deepEqual(
		env.requests[0].form.fields.map(([key]) => key),
		['files[]'],
	)
	assert.deepEqual(env.sent, [['c1', sendOptions('look at this\nhttps://pomf2.lain.la/f/video.mp4')]])
})

test('the proxy receives the destination and links can be rewritten', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] })
	const env = setup({
		settings: { proxyUrl: 'https://proxy.example//', proxyLinks: true, userhash: 'hash' },
		respond: url =>
			url === 'https://proxy.example/direct'
				? { body: JSON.stringify({ url: 'https://files.catbox.moe/abc.mp4?x=1' }) }
				: { status: 404, body: '' },
	})
	await runUpload(t, env, env.upload())
	assert.equal(env.requests.length, 1)
	const { fields } = env.requests[0]
	assert.equal(fields.destination, 'catbox')
	assert.equal(fields.time, '72h')
	assert.equal(fields.userhash, 'hash')
	assert.equal(fields.file.name, 'video.mp4')
	assert.deepEqual(env.sent, [['c1', sendOptions('look at this\nhttps://proxy.example/catbox/abc.mp4')]])
})

test('several files in one message become one link message', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] })
	const env = setup({ settings: { linkStyle: 'name' } })
	await runUpload(t, env, env.upload({ filename: 'a [1].mp4' }), env.upload({ filename: 'b.mp4' }))

	assert.equal(env.requests.length, 2)
	assert.deepEqual(env.sent, [
		[
			'c1',
			sendOptions(
				'look at this\n[a 1.mp4](https://files.catbox.moe/a [1].mp4)\n[b.mp4](https://files.catbox.moe/b.mp4)',
			),
		],
	])
	assert.equal(env.toasts.at(-1).text, 'Links sent.')
})

test('long link messages are split into 2000-character chunks', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] })
	const line = 'x'.repeat(900)
	const env = setup({ pendingContent: `${line}\n${line}\n${line}` })
	await runUpload(t, env, env.upload())
	assert.equal(env.sent.length, 2)
	assert.equal(env.sent[0][1].content, `${line}\n${line}`)
	assert.equal(env.sent[1][1].content, `${line}\nhttps://files.catbox.moe/video.mp4`)
	assert.ok(env.sent.every(([, message]) => message.content.length <= 2000))
})

test('copy mode copies the link instead of sending it', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] })
	const env = setup({ settings: { afterUpload: 'copy' } })
	await runUpload(t, env, env.upload())
	assert.deepEqual(env.clipboard, ['look at this\nhttps://files.catbox.moe/video.mp4'])
	assert.equal(env.sent.length, 0)
})

test('insert mode appends the link to the next message in that channel', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] })
	const env = setup({ settings: { afterUpload: 'insert' }, pendingContent: null })
	await runUpload(t, env, env.upload())
	assert.equal(env.sent.length, 0)

	await env.messageActions.sendMessage('c2', { content: 'elsewhere' }, undefined, {})
	await env.messageActions.sendMessage('c1', { content: 'hi' }, undefined, {})
	await env.messageActions.sendMessage('c1', { content: 'again' }, undefined, {})
	assert.deepEqual(env.sent, [
		['c2', { content: 'elsewhere' }],
		['c1', { content: 'hi\nhttps://files.catbox.moe/video.mp4' }],
		['c1', { content: 'again' }],
	])
})

test('insert mode copies the link when sendMessage could not be hooked', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] })
	const env = setup({ settings: { afterUpload: 'insert' }, pendingContent: null, editMessage: false })
	await runUpload(t, env, env.upload())
	assert.deepEqual(env.clipboard, ['https://files.catbox.moe/video.mp4'])
	assert.equal(env.sent.length, 0)
	assert.match(env.toasts.at(-1).text, /copied to clipboard instead/)
})

test('/litterbox is added to chat commands and routes the next upload', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] })
	const env = setup()

	const list = env.commands.getBuiltInCommands(1, true, false)
	const command = list.find(c => c.name === 'litterbox')
	assert.ok(command)
	assert.equal(command.id, '-6')
	assert.equal(command.applicationId, '-1')
	assert.equal(command.options[0].name, 'duration')
	assert.equal(list.length, 3)
	assert.ok(env.commands.getBuiltInCommands([1, 2]).some(c => c.name === 'litterbox'))
	assert.ok(!env.commands.getBuiltInCommands(2).some(c => c.name === 'litterbox'))

	assert.equal(command.execute([{ name: 'duration', value: '10' }], {}), undefined)
	assert.equal(env.toasts.at(-1).text, 'Next upload goes to Litterbox for 12h')

	await runUpload(t, env, env.upload())
	assert.equal(env.requests[0].url, LITTERBOX)
	assert.equal(env.requests[0].fields.time, '12h')

	// The override is one-shot.
	await runUpload(t, env, env.upload())
	assert.equal(env.requests[1].url, CATBOX)
})

test('/litterbox parses days and falls back to the default expiry', () => {
	const env = setup({ settings: { litterboxTime: '24h' } })
	const command = env.commands.getBuiltInCommands(1).find(c => c.name === 'litterbox')
	command.execute([{ name: 'duration', value: '3d' }])
	assert.equal(env.toasts.at(-1).text, 'Next upload goes to Litterbox for 72h')
	command.execute([])
	assert.equal(env.toasts.at(-1).text, 'Next upload goes to Litterbox for 24h')
	command.execute([{ name: 'duration', value: 'soon' }])
	assert.equal(env.toasts.at(-1).text, 'Next upload goes to Litterbox for 24h')
})

test('/litterbox is hidden when the command setting is off', () => {
	const env = setup({ settings: { command: false } })
	assert.ok(!env.commands.getBuiltInCommands(1, true, false).some(c => c.name === 'litterbox'))
	env.jsonStorage.cache.command = true
	assert.ok(env.commands.getBuiltInCommands(1, true, false).some(c => c.name === 'litterbox'))
})

test('stopping restores every patched method', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] })
	const env = setup({ settings: { afterUpload: 'insert' } })
	await runUpload(t, env, env.upload())

	assert.notEqual(env.CloudUpload.prototype.reactNativeCompressAndExtractData, env.originalCompress)
	env.stop()
	assert.equal(env.CloudUpload.prototype.reactNativeCompressAndExtractData, env.originalCompress)
	assert.equal(env.messageActions.sendMessage, env.originalSendMessage)
	assert.equal(env.commands.getBuiltInCommands, env.originalGetBuiltInCommands)

	// Nothing is appended to messages any more.
	await env.messageActions.sendMessage('c1', { content: 'hi' }, undefined, {})
	assert.deepEqual(env.sent.at(-1), ['c1', { content: 'hi' }])
})

test('the settings page renders and saves changes', () => {
	const env = setup({ settings: { limitMb: 50, proxyUrl: 'https://proxy.example///' } })
	const page = env.options.SettingsComponent({ api: env.api })
	assert.equal(page.type, 'Page')

	const groups = findAll(page, node => node.type === 'TableRadioGroup')
	assert.deepEqual(
		groups.map(group => group.props.title),
		['Upload to', 'Litterbox expiry', 'Your Discord upload limit', 'After uploading', 'Link style'],
	)
	const limit = groups[2]
	assert.equal(limit.props.value, '50')
	assert.deepEqual(
		findAll(limit, node => node.type === 'TableRadioRow').map(row => row.props.value),
		['10', '50', '100', '500'],
	)
	limit.props.onChange('500')
	assert.deepEqual(env.saved.at(-1), { limitMb: 500 })

	const switches = findAll(page, node => node.type === 'TableSwitchRow')
	assert.deepEqual(
		switches.map(row => row.props.label),
		[
			'Upload every file',
			'Try other hosts if one fails',
			'/litterbox command',
			'Rewrite links through proxy',
		],
	)
	switches[0].props.onValueChange(true)
	assert.deepEqual(env.saved.at(-1), { alwaysUpload: true })

	const inputs = findAll(page, node => typeof node.type === 'function').map(node => node.type(node.props))
	assert.deepEqual(
		inputs.map(input => [input.type, input.props.label, !!input.props.secureTextEntry]),
		[
			['TextInput', 'Catbox userhash', true],
			['TextInput', 'Proxy URL', false],
		],
	)
	const proxy = inputs[1]
	proxy.props.onChange('https://other.example/')
	assert.deepEqual(env.saved.at(-1), { proxyUrl: 'https://other.example/' })
	// The draft still holds the initial value here, since the useState mock never re-renders.
	proxy.props.onBlur()
	assert.deepEqual(env.saved.at(-1), { proxyUrl: 'https://proxy.example' })
})

test('index.json lists every release zip with a matching digest and manifest', () => {
	const index = JSON.parse(readFileSync(new URL('../index.json', import.meta.url), 'utf8'))
	assert.equal(index.format, 1)

	const zips = readdirSync(new URL('../release/', import.meta.url)).filter(name => name.endsWith('.zip'))
	assert.ok(zips.length > 0)
	for (const file of zips) {
		const bytes = readFileSync(new URL(`../release/${file}`, import.meta.url))
		const manifest = JSON.parse(strFromU8(unzipSync(bytes)['manifest.json']))
		const version = index.plugins[manifest.id]?.versions[manifest.version]
		assert.ok(version, `${file} is missing from index.json`)
		assert.equal(version.url, `https://raw.githubusercontent.com/ndb1995/valenced-plugins/main/release/${encodeURIComponent(file)}`)
		assert.equal(version.sha256, createHash('sha256').update(bytes).digest('hex'))
		assert.equal(version.size, bytes.length)
		assert.deepEqual(version.dependencies, manifest.dependencies)
	}
	const { version } = JSON.parse(readFileSync(new URL('../plugins/catbox-upload/manifest.json', import.meta.url), 'utf8'))
	assert.equal(index.plugins['ndb1995.catbox-upload'].channels.latest, version)
})

test('a failed sendMessage falls back to the REST API and removes the failed copy', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] })
	const env = setup({ sendMessageError: { status: 400, body: { message: 'Invalid Form Body', code: 50035 } } })
	await runUpload(t, env, env.upload())

	const content = 'look at this\nhttps://files.catbox.moe/video.mp4'
	assert.deepEqual(env.httpRequests, [{ url: '/channels/c1/messages', body: { content, tts: false } }])
	assert.deepEqual(Object.values(env.pending.c1), [], 'the failed copy is deleted')
	assert.equal(env.clipboard.length, 0)
	assert.deepEqual(
		{ text: env.toasts.at(-1).text, variant: env.toasts.at(-1).variant },
		{ text: 'Link sent.', variant: 'success' },
	)
})

test('when every send fails, the reason is shown and the link is copied', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] })
	const env = setup({
		sendMessageError: new Error('boom'),
		httpResponse: { ok: false, status: 403, body: { message: 'Missing Permissions', code: 50013 } },
	})
	await runUpload(t, env, env.upload())

	assert.deepEqual(env.clipboard, ['look at this\nhttps://files.catbox.moe/video.mp4'])
	const last = env.toasts.at(-1)
	assert.equal(last.variant, 'critical')
	assert.equal(
		last.text,
		"Couldn't send the link, copied to clipboard instead. sendMessage: boom; REST: HTTP 403 Missing Permissions (code 50013)",
	)
})

test('the debug log can be copied from the settings page', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] })
	const env = setup({ sendMessageError: new Error('boom') })
	await runUpload(t, env, env.upload())

	const page = env.options.SettingsComponent({ api: env.api })
	const [row] = findAll(page, node => node.type === 'TableRow' && node.props.label === 'Copy debug log')
	assert.ok(row, 'the Diagnostics row is rendered')
	row.props.onPress()

	const copied = env.clipboard.at(-1).split('\n')
	assert.equal(copied[0], 'Catbox Uploader 1.0.3')
	const log = copied.slice(1).join('\n')
	assert.match(log, /LOG Hooked CloudUpload/)
	assert.match(log, /LOG Hooked sendMessage, module keys: sendMessage,editMessage/)
	assert.match(log, /LOG Uploaded video\.mp4 \(50 MB\): https:\/\/files\.catbox\.moe\/video\.mp4/)
	assert.match(log, /ERROR sendMessage failed, trying the REST API\. Module keys: sendMessage,editMessage boom/)
	assert.match(log, /LOG Sent the link through the REST API/)
	assert.equal(env.toasts.at(-1).text, 'Debug log copied')
})

test('settings saved by 1.0.x with maskedLinks still get previewable bare links', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] })
	const env = setup({ settings: { maskedLinks: true }, pendingContent: null })
	await runUpload(t, env, env.upload())
	assert.deepEqual(env.sent, [['c1', sendOptions('https://files.catbox.moe/video.mp4')]])
})

test('an anonymous "Invalid uploader" from catbox falls back and points at the userhash setting', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] })
	const invalidUploader = (url, form) =>
		url === CATBOX ? { status: 412, body: 'Invalid uploader' } : defaultRespond(url, form)
	const env = setup({ respond: invalidUploader, pendingContent: null })
	await runUpload(t, env, env.upload())

	assert.deepEqual(
		env.requests.map(r => r.url),
		[CATBOX, LITTERBOX],
	)
	assert.equal(env.sent.length, 1)
	assert.equal(
		env.toasts.at(-1).text,
		'Link sent. Catbox refused the anonymous upload. Add your catbox.moe userhash in the plugin settings to use Catbox.',
	)

	const withUserhash = setup({ respond: invalidUploader, pendingContent: null, settings: { userhash: 'abc' } })
	await runUpload(t, withUserhash, withUserhash.upload())
	assert.equal(withUserhash.toasts.at(-1).text, 'Link sent.')
})
