import { Page } from '@valenced/components'
import { Design } from '@valenced/discord/design'
import type { PluginApi } from '@valenced/plugins/types'
import { useState } from 'react'
import { ScrollView } from 'react-native'
import { normalizeProxyUrl } from './hosts'
import { type AfterUpload, DEFAULTS, type Host, type LitterboxTime, type Settings } from './settings'

type Api = PluginApi<{ jsonStorage: Settings }>

export default function SettingsPage({ api }: { api: Api }) {
	const { Stack, TableRadioGroup, TableRadioRow, TableRowGroup, TableSwitchRow } = Design
	const settings = { ...DEFAULTS, ...api.jsonStorage.use() }
	const save = (value: Partial<Settings>) => {
		void api.jsonStorage.set(value)
	}

	return (
		<Page spacing={0}>
			<ScrollView keyboardShouldPersistTaps="handled" style={{ flex: 1 }}>
				<Stack spacing={24} style={{ paddingBottom: 32 }}>
					<TableRadioGroup title="Upload to" value={settings.host} onChange={(host: Host) => save({ host })}>
						<TableRadioRow label="Catbox" subLabel="Permanent, up to 200 MB" value="catbox" />
						<TableRadioRow label="Litterbox" subLabel="Temporary, up to 1 GB" value="litterbox" />
						<TableRadioRow label="Pomf" subLabel="pomf.lain.la, up to 1 GB" value="pomf" />
					</TableRadioGroup>

					<TableRadioGroup
						title="Litterbox expiry"
						value={settings.litterboxTime}
						onChange={(litterboxTime: LitterboxTime) => save({ litterboxTime })}
					>
						<TableRadioRow label="1 hour" value="1h" />
						<TableRadioRow label="12 hours" value="12h" />
						<TableRadioRow label="24 hours" value="24h" />
						<TableRadioRow label="3 days" value="72h" />
					</TableRadioGroup>

					<TableRadioGroup
						title="Your Discord upload limit"
						value={String(settings.limitMb)}
						onChange={(value: string) => save({ limitMb: Number(value) as Settings['limitMb'] })}
					>
						<TableRadioRow label="10 MB" subLabel="Free" value="10" />
						<TableRadioRow label="50 MB" subLabel="Nitro Basic or Level 2 server" value="50" />
						<TableRadioRow label="100 MB" subLabel="Level 3 server" value="100" />
						<TableRadioRow label="500 MB" subLabel="Nitro" value="500" />
					</TableRadioGroup>

					<TableRadioGroup
						title="After uploading"
						value={settings.afterUpload}
						onChange={(afterUpload: AfterUpload) => save({ afterUpload })}
					>
						<TableRadioRow label="Send the link in chat" value="send" />
						<TableRadioRow label="Add the link to my next message" value="insert" />
						<TableRadioRow label="Copy the link" value="copy" />
					</TableRadioGroup>

					<TableRowGroup title="Options">
						<TableSwitchRow
							label="Upload every file"
							subLabel="Also reroute files under your limit"
							value={settings.alwaysUpload}
							onValueChange={alwaysUpload => save({ alwaysUpload })}
						/>
						<TableSwitchRow
							label="Try other hosts if one fails"
							value={settings.fallback}
							onValueChange={fallback => save({ fallback })}
						/>
						<TableSwitchRow
							label="Show file name instead of URL"
							value={settings.maskedLinks}
							onValueChange={maskedLinks => save({ maskedLinks })}
						/>
						<TableSwitchRow
							label="/litterbox command"
							value={settings.command}
							onValueChange={command => save({ command })}
						/>
					</TableRowGroup>

					<SettingTextInput
						label="Catbox userhash"
						placeholder="Optional: links uploads to your catbox.moe account"
						secureTextEntry
						value={settings.userhash}
						normalize={text => text.trim()}
						onSave={userhash => save({ userhash })}
					/>

					<Stack spacing={12}>
						<TableRowGroup title="Proxy (advanced)">
							<TableSwitchRow
								label="Rewrite links through proxy"
								disabled={!settings.proxyUrl}
								value={settings.proxyLinks}
								onValueChange={proxyLinks => save({ proxyLinks })}
							/>
						</TableRowGroup>
						<SettingTextInput
							label="Proxy URL"
							placeholder="https://your-proxy.example"
							value={settings.proxyUrl}
							normalize={normalizeProxyUrl}
							onSave={proxyUrl => save({ proxyUrl })}
						/>
					</Stack>
				</Stack>
			</ScrollView>
		</Page>
	)
}

interface SettingTextInputProps {
	label: string
	placeholder: string
	value: string
	secureTextEntry?: boolean
	normalize?: (value: string) => string
	onSave: (value: string) => void
}

// Keeps a local draft so normalizing (like stripping a trailing slash) waits until editing is done.
function SettingTextInput({ value, normalize, onSave, ...props }: SettingTextInputProps) {
	const { TextInput } = Design
	const [draft, setDraft] = useState(value)

	return (
		<TextInput
			{...props}
			size="md"
			value={draft}
			onChange={text => {
				setDraft(text)
				onSave(text)
			}}
			onBlur={() => {
				const normalized = normalize ? normalize(draft) : draft
				if (normalized === draft) return
				setDraft(normalized)
				onSave(normalized)
			}}
		/>
	)
}
