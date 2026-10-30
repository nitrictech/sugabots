import {
	DEFAULT_SEARCH_PRESET,
	type SearchProvider,
	type SearchProviderPresetId,
	type SearchProviderTestResult,
	type SearchProviderUpdate,
	searchProviderCatalog,
	searchProviderPreset,
} from "@sugabots/contracts";
import { type ReactNode, useId, useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { useSearchProvider, useSearchProviderActions } from "@/lib/search-provider.ts";
import { Alert, Success } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import {
	SETTINGS_CARD,
	SETTINGS_RADIO_ROW,
	SettingsGroup,
	SettingsRadioMark,
	SettingsRow,
	SettingsRowIcon,
} from "@/ui/settings-page.tsx";
import { Toggle } from "@/ui/toggle.tsx";
import { TextEntryRow } from "./text-entry-row.tsx";

/*
 * The workspace's web search settings: a switch for whether bots may use the
 * web, and, under Advanced, which provider answers searches. Turning the
 * switch on gives every bot the `web_fetch` and `web_search` tools. Exa
 * answers until another provider is chosen, and its key is optional, so the
 * switch works on a fresh workspace; a provider that needs a key keeps the
 * switch disabled until the key is added.
 */

/** What each provider is good for, in the line under its name. */
const providerDescriptions: Record<SearchProviderPresetId, string> = {
	exa: "Works out of the box",
	brave: "Independent index, simple pricing",
	tavily: "Made for AI agents",
	searxng: "Runs on your own server",
};

export function WebSearchSettings() {
	const provider = useSearchProvider();
	if (provider.isPending) return null;
	if (provider.isError) return <Alert>{failureMessage(provider.error)}</Alert>;
	return <WebSearchGroups provider={provider.data ?? null} />;
}

function WebSearchGroups({ provider }: { provider: SearchProvider | null }) {
	const actions = useSearchProviderActions();
	const chosen = provider?.preset ?? DEFAULT_SEARCH_PRESET;
	const preset = searchProviderPreset(chosen);
	const needsKey = preset.requiresApiKey && provider?.hasApiKey !== true;
	// Opened for you when the switch is held off by a missing key, so the reason is in view.
	const [advancedOpen, setAdvancedOpen] = useState(needsKey);
	const [error, setError] = useState<string>();
	const pending =
		actions.replace.isPending ||
		actions.update.isPending ||
		actions.test.isPending ||
		actions.remove.isPending;
	const enabled = provider?.enabled ?? false;
	const advancedId = useId();

	async function act(work: () => Promise<unknown>) {
		setError(undefined);
		try {
			await work();
		} catch (cause) {
			setError(failureMessage(cause));
		}
	}

	/**
	 * Swaps the provider, keeping the switch as it was unless the new one needs a
	 * key: a new provider starts without one, and the web can't be on with a
	 * provider that can't search, so it goes off until the key is added.
	 */
	function choose(next: SearchProviderPresetId) {
		if (next === chosen) return;
		const nextEnabled = enabled && !searchProviderPreset(next).requiresApiKey;
		void act(() => actions.replace.mutateAsync({ preset: next, enabled: nextEnabled }));
	}

	/** Changes the provider's settings, setting the default provider up first when there is none. */
	function configure(change: SearchProviderUpdate) {
		return act(() =>
			provider
				? actions.update.mutateAsync(change)
				: actions.replace.mutateAsync({
						preset: chosen,
						enabled: change.enabled ?? enabled,
						baseUrl: change.baseUrl,
						apiKey: change.apiKey ?? undefined,
					}),
		);
	}

	return (
		<>
			<SettingsGroup
				note={needsKey ? `${preset.name} needs an API key first. Add it below.` : undefined}
			>
				<SettingsRow
					label="Bots can use the web"
					sub="Search the web and read web pages"
					trailing={
						<Toggle
							checked={enabled}
							disabled={needsKey || pending}
							label="Bots can use the web"
							tooltip={needsKey ? `${preset.name} requires an API key` : undefined}
							onChange={(next) => configure({ enabled: next })}
						/>
					}
				/>
			</SettingsGroup>
			<div className="-mt-3 flex flex-col gap-7">
				<Button
					variant="secondary"
					size="sm"
					aria-expanded={advancedOpen}
					aria-controls={advancedId}
					onClick={() => setAdvancedOpen(!advancedOpen)}
					className="self-start"
				>
					{advancedOpen ? "Hide advanced" : "Show advanced"}
				</Button>
				{advancedOpen && (
					<div id={advancedId} className="flex flex-col gap-7">
						<ProviderChoice chosen={chosen} disabled={pending} onChoose={choose} />
						<ProviderSettings
							key={chosen}
							chosen={chosen}
							provider={provider}
							pending={pending}
							testResult={actions.test.data}
							onConfigure={configure}
							onTest={() => act(() => actions.test.mutateAsync())}
						/>
					</div>
				)}
			</div>
			{error && <Alert>{error}</Alert>}
		</>
	);
}

/** The providers as one pick-one list, the chosen one ticked. */
function ProviderChoice({
	chosen,
	disabled,
	onChoose,
}: {
	chosen: SearchProviderPresetId;
	disabled: boolean;
	onChoose: (preset: SearchProviderPresetId) => void;
}) {
	const name = useId();
	return (
		<fieldset className="m-0 flex min-w-0 flex-col border-0 p-0" disabled={disabled}>
			<legend className="px-0.5 pb-2.5 font-medium text-[13px] text-muted-foreground">
				Provider
			</legend>
			<div className={SETTINGS_CARD}>
				{searchProviderCatalog.map((candidate) => (
					<label key={candidate.id} className={SETTINGS_RADIO_ROW}>
						<input
							type="radio"
							name={name}
							value={candidate.id}
							checked={candidate.id === chosen}
							onChange={() => onChoose(candidate.id)}
							className="sr-only"
						/>
						<SettingsRowIcon>{candidate.name.charAt(0)}</SettingsRowIcon>
						<span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-[1.4]">
							<span className="truncate font-medium text-[13px] text-foreground">
								{candidate.name}
							</span>
							<span className="text-pretty text-subtle-foreground text-xs">
								{providerDescriptions[candidate.id]}
							</span>
						</span>
						<SettingsRadioMark checked={candidate.id === chosen} />
					</label>
				))}
			</div>
		</fieldset>
	);
}

/** The chosen provider's address, when it is a server you run, and its key. */
function ProviderSettings({
	chosen,
	provider,
	pending,
	testResult,
	onConfigure,
	onTest,
}: {
	chosen: SearchProviderPresetId;
	provider: SearchProvider | null;
	pending: boolean;
	testResult: SearchProviderTestResult | undefined;
	onConfigure: (change: SearchProviderUpdate) => Promise<void>;
	onTest: () => void;
}) {
	const preset = searchProviderPreset(chosen);
	const [removingKey, setRemovingKey] = useState(false);
	const hasKey = provider?.hasApiKey === true;

	return (
		<SettingsGroup label={preset.name} note={testStanding(provider, testResult) ?? keyHint(chosen)}>
			{preset.hosting === "local" && (
				<TextEntryRow
					label="Server URL"
					saved={provider?.baseUrl ?? preset.baseUrl}
					placeholder={preset.baseUrl}
					disabled={pending}
					onSave={(baseUrl) => onConfigure({ baseUrl })}
				/>
			)}
			<TextEntryRow
				label="API key"
				secret
				saved={hasKey ? "" : undefined}
				placeholder="Paste your key"
				disabled={pending}
				onSave={(apiKey) => onConfigure({ apiKey })}
				onRemove={hasKey ? () => setRemovingKey(true) : undefined}
			/>
			{provider && (hasKey || !preset.requiresApiKey) && (
				<SettingsRow
					label="Test search"
					sub="Runs one search with these settings."
					onClick={pending ? undefined : onTest}
				/>
			)}
			<DeleteDialog
				open={removingKey}
				onOpenChange={setRemovingKey}
				title={`Remove the ${preset.name} key?`}
				description={
					preset.requiresApiKey
						? "Bots stop using the web until another key is added."
						: "Searches carry on without a key, within the provider's free limits."
				}
				confirmLabel="Remove"
				pending={pending}
				onDelete={async () => {
					await onConfigure({ apiKey: null });
					setRemovingKey(false);
				}}
			/>
		</SettingsGroup>
	);
}

function keyHint(preset: SearchProviderPresetId): string {
	if (preset === "exa") {
		return "A key is optional. Without one, searches use Exa's free tier, which is rate limited.";
	}
	return searchProviderPreset(preset).requiresApiKey ? "A key is required." : "A key is optional.";
}

/** What the last test search said, once one has run, or what the provider recorded. */
function testStanding(
	provider: SearchProvider | null,
	latest: SearchProviderTestResult | undefined,
): ReactNode {
	if (latest) {
		return latest.reachable ? (
			<Success>Search works</Success>
		) : (
			<Alert>{latest.error ?? "The search did not work."}</Alert>
		);
	}
	if (provider?.status === "connected") return "The last test search worked.";
	if (provider?.status === "error") {
		return <Alert>{provider.lastTestError ?? "The last test search failed."}</Alert>;
	}
	return undefined;
}
