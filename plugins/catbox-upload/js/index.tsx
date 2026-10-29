import { patchCommands } from './command'
import SettingsPage from './SettingsPage'
import { bindStorage, DEFAULTS, type Settings } from './settings'
import { patchMessageSender, patchUploader, resetUploaderState } from './uploader'
import { setLog } from './utils'

export default plugin<{ jsonStorage: Settings }>({
	jsonStorage: { default: DEFAULTS, load: true },
	start({ cleanup, jsonStorage, logger }) {
		bindStorage(jsonStorage)
		setLog(logger)
		cleanup(() => {
			resetUploaderState()
			bindStorage(undefined)
			setLog(undefined)
		})

		patchMessageSender(cleanup)
		patchUploader(cleanup)
		patchCommands(cleanup)
	},
	SettingsComponent: SettingsPage,
})
