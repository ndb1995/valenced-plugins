// Bundles plugins/catbox-upload into a single-expression Valenced script and packages it.
//
// Valenced evaluates the script as `new Function('valenced', 'plugin', 'return ' + script)`
// during preInit, before React and Discord's UI modules exist. Externals are therefore
// passed in as lazy proxies that only resolve `valenced.*` when a property is read.

import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transform } from '@swc/core'
import { strFromU8, unzipSync, zipSync } from 'fflate'
import { rolldown } from 'rolldown'

const REPO_BASE_URL = 'https://raw.githubusercontent.com/ndb1995/valenced-plugins/main'
const REPO_NAME = "ndb1995's Valenced plugins"
const REPO_DESCRIPTION = 'Catbox Uploader: send files over the Discord upload limit through catbox.moe, Litterbox or Pomf.'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginDir = join(root, 'plugins/catbox-upload')
const require = createRequire(import.meta.url)

const readJson = async path => JSON.parse(await readFile(path, 'utf8'))

const manifestBytes = await readFile(join(pluginDir, 'manifest.json'))
const manifest = JSON.parse(manifestBytes.toString('utf8'))

/** Import specifier -> expression that yields the runtime value. */
const targets = new Map([
	['react', 'valenced.react.React'],
	['react-native', 'valenced.react.ReactNative'],
	['react/jsx-runtime', 'valenced.react.ReactJSXRuntime'],
])
for (const file of ['modules.importmap.json', 'modules.hidden.importmap.json']) {
	const importmap = await readJson(require.resolve(`@valenced/types/${file}`))
	for (const [specifier, entry] of Object.entries(importmap))
		targets.set(specifier, typeof entry === 'string' ? entry : entry.global)
}

// 1. Bundle to an IIFE whose parameters are the externals.
const used = []
const bundle = await rolldown({
	input: join(pluginDir, 'js/index.tsx'),
	platform: 'neutral',
	external: id => targets.has(id),
	transform: { jsx: { runtime: 'automatic', development: false } },
	onwarn(warning, warn) {
		// The IIFE's value is used directly, so it needs no global name.
		if (warning.code !== 'MISSING_NAME_OPTION_FOR_IIFE_EXPORT') warn(warning)
	},
})
const { output } = await bundle.generate({
	format: 'iife',
	exports: 'named',
	esModule: false,
	globals: id => {
		if (!used.includes(id)) used.push(id)
		return `$ext${used.indexOf(id)}`
	},
})
await bundle.close()

const iife = output[0].code.trim().replace(/;$/, '')
if (!iife.startsWith('(function(')) throw new Error('Unexpected rolldown output: expected an IIFE')
for (const helper of ['__toESM', '__commonJS', '__require'])
	if (iife.includes(helper))
		throw new Error(`Bundle uses ${helper}; only named imports of externals are supported`)

// 2. Wrap it so each external resolves its target on every property read.
const lazy =
	'function(resolve){return new Proxy({},{' +
	'get:function(_,key){return resolve()[key]},' +
	'has:function(_,key){return key in resolve()}' +
	'})}'
const externals = used
	.map((id, i) => `var $ext${i}=$lazy(function(){return ${targets.get(id)}});`)
	.join('\n')
const wrapped = `(function(){\nvar $lazy=${lazy};\n${externals}\nreturn ${iife}\n})()`

// 3. Lower syntax the same way Valenced does for Hermes.
const { code: lowered } = await transform(wrapped, {
	filename: 'index.js',
	isModule: false,
	minify: false,
	sourceMaps: false,
	jsc: { parser: { syntax: 'ecmascript' }, externalHelpers: false },
	env: {
		targets: 'fully supports es6',
		include: [
			'transform-arrow-functions',
			'transform-async-generator-functions',
			'transform-block-scoping',
			'transform-classes',
			'transform-duplicate-named-capturing-groups-regex',
			'transform-named-capturing-groups-regex',
		],
		exclude: [
			'transform-async-to-generator',
			'transform-exponentiation-operator',
			'transform-logical-assignment-operators',
			'transform-nullish-coalescing-operator',
			'transform-numeric-separator',
			'transform-object-rest-spread',
			'transform-optional-catch-binding',
			'transform-optional-chaining',
			'transform-parameters',
			'transform-template-literals',
		],
	},
})
const code = `${lowered.trim()}\n`
if (!code.startsWith('(')) throw new Error('Script must be a single expression starting with "("')

// 4. Self-check: loading must not touch the Valenced API at all.
const accessed = []
const throwing = new Proxy(
	{},
	Object.fromEntries(
		['get', 'has', 'set', 'ownKeys', 'getOwnPropertyDescriptor', 'apply', 'construct'].map(trap => [
			trap,
			(_, key) => {
				accessed.push(String(key))
				throw new Error(`valenced was accessed at load time (${trap} ${String(key)})`)
			},
		]),
	),
)
const options = new Function('valenced', 'plugin', `return ${code}\n//# sourceURL=self-check`)(
	throwing,
	opts => opts,
)?.default
if (accessed.length) throw new Error(`Self-check failed: accessed ${accessed.join(', ')}`)
for (const key of ['start', 'SettingsComponent'])
	if (typeof options?.[key] !== 'function') throw new Error(`Self-check failed: ${key} is not a function`)
console.log(
	`Self-check passed: loads without touching valenced; start and SettingsComponent are functions (${used.length} externals: ${used.join(', ')})`,
)

// 5. Write the script and the installable zip.
const scriptPath = join(pluginDir, 'build/js', manifest.dist.script)
await mkdir(dirname(scriptPath), { recursive: true })
await writeFile(scriptPath, code)

const zipPath = join(root, 'release', `${manifest.id}@${manifest.version}.zip`)
await mkdir(dirname(zipPath), { recursive: true })
const zip = zipSync(
	{
		'manifest.json': new Uint8Array(manifestBytes),
		[manifest.dist.script]: new TextEncoder().encode(code),
	},
	// Fixed timestamp so rebuilding unchanged sources gives an identical zip.
	{ level: 9, mtime: new Date('2026-01-01T00:00:00Z') },
)
await writeFile(zipPath, zip)

console.log(`Wrote ${relative(root, scriptPath)} (${code.length} bytes)`)
console.log(`Wrote ${relative(root, zipPath)} (${zip.length} bytes)`)

// 6. Regenerate the repository index from every zip in release/, so users can add the repo by URL.
const releaseDir = join(root, 'release')
const plugins = {}
for (const file of (await readdir(releaseDir)).filter(name => name.endsWith('.zip')).sort()) {
	const bytes = await readFile(join(releaseDir, file))
	const zipped = JSON.parse(strFromU8(unzipSync(bytes, { filter: entry => entry.name === 'manifest.json' })['manifest.json']))
	if (file !== `${zipped.id}@${zipped.version}.zip`) throw new Error(`${file} holds ${zipped.id}@${zipped.version}`)

	const entry = (plugins[zipped.id] ??= { channels: {}, versions: {} })
	Object.assign(entry, {
		name: zipped.name,
		description: zipped.description,
		author: zipped.author,
		contributors: zipped.contributors ?? [],
	})
	entry.versions[zipped.version] = {
		url: `${REPO_BASE_URL}/release/${encodeURIComponent(file)}`,
		sha256: createHash('sha256').update(bytes).digest('hex'),
		size: bytes.length,
		// Valenced aborts the install if these differ from the zip's manifest.
		dependencies: zipped.dependencies ?? {},
	}
}
for (const entry of Object.values(plugins)) {
	const versions = Object.keys(entry.versions).sort(compareVersions)
	const stable = versions.filter(version => !version.includes('-'))
	if (stable.length) entry.channels.latest = stable.at(-1)
	if (versions.at(-1) !== entry.channels.latest) entry.channels.beta = versions.at(-1)
}

const index = { format: 1, name: REPO_NAME, description: REPO_DESCRIPTION, plugins }
await writeFile(join(root, 'index.json'), `${JSON.stringify(index, null, '\t')}\n`)
console.log(`Wrote index.json (${Object.keys(plugins).length} plugin(s)), add ${REPO_BASE_URL}/index.json in Valenced`)

/** Orders versions like Valenced: numeric segments, then a labeled version before its bare one. */
function compareVersions(a, b) {
	const parse = version => {
		const [nums, label] = version.split('-')
		return { nums: nums.split('.').map(Number), label }
	}
	const left = parse(a)
	const right = parse(b)
	for (let i = 0; i < Math.max(left.nums.length, right.nums.length); i++) {
		const diff = (left.nums[i] ?? 0) - (right.nums[i] ?? 0)
		if (diff) return diff
	}
	if (left.label === right.label) return 0
	if (left.label === undefined) return 1
	if (right.label === undefined) return -1
	return left.label < right.label ? -1 : 1
}
