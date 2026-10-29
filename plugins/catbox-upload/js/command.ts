import { getModules } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { instead } from '@valenced/patcher'
import { readSettings } from './settings'
import { type Cleanup, setNextUploadOverride } from './uploader'
import { log, parseHours, roundDuration, toast } from './utils'

type AnyFunction = (...args: any[]) => any

const CHAT_INPUT = 1
const FALLBACK_ID = '-31337'
const DESCRIPTION = 'Send your next upload to Litterbox (temporary hosting)'
const DURATION_DESCRIPTION = 'Hours to keep the file: 1, 12, 24 or 72'

// There is no command API, so the command is appended to Discord's own built-in command list.
export function patchCommands(cleanup: Cleanup) {
	cleanup(
		getModules(withProps('getBuiltInCommands'), mod => {
			if (typeof mod?.getBuiltInCommands !== 'function') return
			let command: ReturnType<typeof createCommand> | undefined

			cleanup(
				instead(mod, 'getBuiltInCommands', function (this: unknown, args: any[], original: AnyFunction) {
					const res = original.apply(this, args)
					try {
						if (!readSettings().command || !Array.isArray(res) || !wantsChatCommands(args[0])) return res
						command ??= createCommand(nextFreeId(() => original.call(this, CHAT_INPUT, true, false)))
						return [...res, command]
					} catch (e) {
						log.warn('Could not add the /litterbox command', e)
						return res
					}
				}),
			)
		}),
	)
}

function wantsChatCommands(type: unknown) {
	return type === CHAT_INPUT || (Array.isArray(type) && type.includes(CHAT_INPUT))
}

/** One below the lowest built-in id, so it can't collide with Discord's commands. */
function nextFreeId(getCommands: () => unknown) {
	try {
		const commands = getCommands()
		const ids = Array.isArray(commands)
			? commands.map(command => Number(command?.id)).filter(id => Number.isFinite(id))
			: []
		return ids.length ? String(Math.min(...ids) - 1) : FALLBACK_ID
	} catch {
		return FALLBACK_ID
	}
}

function createCommand(id: string) {
	return {
		id,
		applicationId: '-1',
		type: CHAT_INPUT,
		inputType: 0,
		name: 'litterbox',
		displayName: 'litterbox',
		untranslatedName: 'litterbox',
		description: DESCRIPTION,
		displayDescription: DESCRIPTION,
		untranslatedDescription: DESCRIPTION,
		options: [
			{
				name: 'duration',
				displayName: 'duration',
				description: DURATION_DESCRIPTION,
				displayDescription: DURATION_DESCRIPTION,
				type: 3,
				required: false,
			},
		],
		execute(args: any) {
			try {
				const value = Array.isArray(args)
					? (args.find(arg => arg?.name === 'duration')?.value ?? args[0]?.value)
					: undefined
				const hours = parseHours(value) ?? parseHours(readSettings().litterboxTime) ?? 72
				const rounded = roundDuration(hours)
				setNextUploadOverride({ host: 'litterbox', duration: `${rounded}h` })
				toast('catbox-upload-command', `Next upload goes to Litterbox for ${rounded}h`, 'success')
			} catch (e) {
				log.error('/litterbox failed', e)
			}
			return undefined
		},
	}
}
