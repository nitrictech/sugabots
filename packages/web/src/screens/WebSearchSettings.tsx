import {
	type BuiltInSearchProviderId,
	builtInSearchProviders,
	DEFAULT_SEARCH_BUILT_IN,
	type SearchProvider,
	type SearchProviderTestResult,
	type SearchProviderUpdate,
	searchBuiltInProvider,
} from "@sugabots/contracts";
import { type ReactNode, useId, useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { useProviderSettingsAction } from "@/lib/provider-settings-action.ts";
import { useSearchProvider, useSearchProviderActions } from "@/lib/search-provider.ts";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import {
	SettingsGroup,
	SettingsRadioList,
	SettingsRow,
	SettingsTestOutcome,
} from "@/ui/settings-page.tsx";
import { Switch } from "@/ui/switch.tsx";
import { TextEntryRow } from "./text-entry-row.tsx";

/*
 * The workspace's web search settings: a switch for whether bots may use the
 * web, and, under Advanced, which provider answers searches. Turning the
 * switch on gives every bot the `web_fetch` and `web_search` tools. Exa
 * answers until another provider is chosen, and its key is optional, so the
 * switch works on a fresh workspace; a provider that needs a key keeps the
 * switch disabled until the key is added.
 */

export function WebSearchSettings() {
	const provider = useSearchProvider();
	if (provider.isPending) return null;
	if (provider.isError) return <Alert>{failureMessage(provider.error)}</Alert>;
	return <WebSearchGroups provider={provider.data ?? null} />;
}

function WebSearchGroups({ provider }: { provider: SearchProvider | null }) {
	const actions = useSearchProviderActions();
	const chosen = provider?.builtIn ?? DEFAULT_SEARCH_BUILT_IN;
	const builtIn = searchBuiltInProvider(chosen);
	const needsKey = builtIn.requiresApiKey && provider?.hasApiKey !== true;
	// Opened for you when the switch is held off by a missing key, so the reason is in view.
	const [advancedOpen, setAdvancedOpen] = useState(needsKey);
	const { error, act } = useProviderSettingsAction();
	const pending =
		actions.replace.isPending ||
		actions.update.isPending ||
		actions.test.isPending ||
		actions.remove.isPending;
	const enabled = provider?.enabled ?? false;
	const advancedId = useId();

	/**
	 * Swaps the provider, keeping the switch as it was unless the new one needs a
	 * key: a new provider starts without one, and the web can't be on with a
	 * provider that can't search, so it goes off until the key is added.
	 */
	function choose(next: BuiltInSearchProviderId) {
		if (next === chosen) return;
		const nextEnabled = enabled && !searchBuiltInProvider(next).requiresApiKey;
		void act(() => actions.replace.mutateAsync({ builtIn: next, enabled: nextEnabled }));
	}

	/** Changes the provider's settings, setting the default provider up first when there is none. */
	function configure(change: SearchProviderUpdate) {
		return act(() =>
			provider
				? actions.update.mutateAsync(change)
				: actions.replace.mutateAsync({
						builtIn: chosen,
						enabled: change.enabled ?? enabled,
						baseUrl: change.baseUrl,
						apiKey: change.apiKey ?? undefined,
					}),
		);
	}

	return (
		<>
			<SettingsGroup
				note={needsKey ? `${builtIn.name} needs an API key first. Add it below.` : undefined}
			>
				<SettingsRow
					label="Bots can use the web"
					sub="Search the web and read web pages"
					trailing={
						<Switch
							checked={enabled}
							disabled={needsKey || pending}
							aria-label="Bots can use the web"
							onCheckedChange={(next) => configure({ enabled: next })}
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
						<SettingsRadioList
							legend="Provider"
							options={builtInSearchProviders}
							chosen={chosen}
							disabled={pending}
							onChoose={choose}
						/>
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

/** The chosen provider's address, when it is a server you run, and its key. */
function ProviderSettings({
	chosen,
	provider,
	pending,
	testResult,
	onConfigure,
	onTest,
}: {
	chosen: BuiltInSearchProviderId;
	provider: SearchProvider | null;
	pending: boolean;
	testResult: SearchProviderTestResult | undefined;
	onConfigure: (change: SearchProviderUpdate) => Promise<void>;
	onTest: () => void;
}) {
	const builtIn = searchBuiltInProvider(chosen);
	const [removingKey, setRemovingKey] = useState(false);
	const hasKey = provider?.hasApiKey === true;

	return (
		<SettingsGroup
			label={builtIn.name}
			note={testStanding(provider, testResult) ?? keyHint(chosen)}
		>
			{builtIn.hosting === "local" && (
				<TextEntryRow
					label="Server URL"
					saved={provider?.baseUrl ?? builtIn.baseUrl}
					placeholder={builtIn.baseUrl}
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
			{provider && (hasKey || !builtIn.requiresApiKey) && (
				<SettingsRow
					label="Test search"
					sub="Runs one search with these settings."
					onClick={pending ? undefined : onTest}
				/>
			)}
			<DeleteDialog
				open={removingKey}
				onOpenChange={setRemovingKey}
				title={`Remove the ${builtIn.name} key?`}
				description={
					builtIn.requiresApiKey
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

function keyHint(builtIn: BuiltInSearchProviderId): string {
	if (builtIn === "exa") {
		return "A key is optional. Without one, searches use Exa's free tier, which is rate limited.";
	}
	return searchBuiltInProvider(builtIn).requiresApiKey
		? "A key is required."
		: "A key is optional.";
}

/** What the last test search said, once one has run, or what the provider recorded. */
function testStanding(
	provider: SearchProvider | null,
	latest: SearchProviderTestResult | undefined,
): ReactNode {
	if (latest) {
		return (
			<SettingsTestOutcome good={latest.reachable}>
				{latest.reachable ? "Search works" : (latest.error ?? "The search did not work.")}
			</SettingsTestOutcome>
		);
	}
	if (provider?.status === "connected") return "The last test search worked.";
	if (provider?.status === "error") {
		return (
			<SettingsTestOutcome good={false}>
				{provider.lastTestError ?? "The last test search failed."}
			</SettingsTestOutcome>
		);
	}
	return undefined;
}
