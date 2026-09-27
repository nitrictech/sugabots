import {
	DEFAULT_SEARCH_PRESET,
	type SearchProvider,
	type SearchProviderPresetId,
	type SearchProviderTestResult,
	type SearchProviderUpdate,
	searchProviderCatalog,
	searchProviderPreset,
} from "@sugabots/contracts";
import { Check } from "lucide-react";
import { useId, useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { useSearchProvider, useSearchProviderActions } from "@/lib/search-provider.ts";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import { SettingsGroup, SettingsRow, SettingsRowIcon } from "@/ui/settings-page.tsx";
import { Toggle } from "@/ui/toggle.tsx";

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
						<ProviderChoice
							chosen={chosen}
							disabled={pending}
							onChoose={(next) => act(() => actions.replace.mutateAsync({ preset: next, enabled }))}
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
			<legend className="px-1 pb-2 font-medium text-sm text-subtle-foreground">Provider</legend>
			<div className="overflow-hidden rounded-panel bg-list">
				{searchProviderCatalog.map((candidate) => (
					<label
						key={candidate.id}
						className="flex cursor-pointer items-center gap-3 border-border border-b px-4 py-3 transition-colors last:border-b-0 hover:bg-panel has-focus-visible:shadow-(--ring-shadow) has-disabled:cursor-default"
					>
						<input
							type="radio"
							name={name}
							value={candidate.id}
							checked={candidate.id === chosen}
							onChange={() => onChoose(candidate.id)}
							className="sr-only"
						/>
						<SettingsRowIcon>{candidate.name.charAt(0)}</SettingsRowIcon>
						<span className="flex min-w-0 flex-1 flex-col gap-px">
							<span className="truncate font-medium text-[14.5px] text-foreground">
								{candidate.name}
							</span>
							<span className="truncate text-muted-foreground text-sm">
								{providerDescriptions[candidate.id]}
							</span>
						</span>
						{candidate.id === chosen && (
							<Check aria-hidden size={16} strokeWidth={2.4} className="shrink-0 text-link" />
						)}
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
				savedDisplay={hasKey ? (provider?.apiKeyHint ?? "••••••••") : undefined}
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

/**
 * A row that takes a value typed in place: a server's address, or a key. It
 * saves on Enter or when you leave it, and a secret shows only its hint once
 * saved, with Replace and Remove beside it.
 */
export function TextEntryRow({
	label,
	saved,
	savedDisplay,
	placeholder,
	secret = false,
	disabled,
	onSave,
	onRemove,
}: {
	label: string;
	/** The stored value, or `undefined` when there is none. A secret's is never sent, so it is "". */
	saved: string | undefined;
	/** What stands for a stored secret, such as its last characters. */
	savedDisplay?: string;
	placeholder: string;
	secret?: boolean;
	disabled: boolean;
	onSave: (value: string) => Promise<void>;
	onRemove?: () => void;
}) {
	const id = useId();
	const [replacing, setReplacing] = useState(false);
	const [draft, setDraft] = useState(secret ? "" : (saved ?? ""));
	const showingSecret = secret && savedDisplay !== undefined && !replacing;

	function commit() {
		const value = draft.trim();
		if (value === "" || value === saved) {
			if (!secret) setDraft(saved ?? "");
			return;
		}
		void onSave(value).then(() => {
			if (secret) {
				setDraft("");
				setReplacing(false);
			}
		});
	}

	return (
		<div className="flex min-h-12 items-center gap-3 border-border border-b px-4 py-2.5 last:border-b-0">
			<label htmlFor={id} className="w-[82px] shrink-0 text-[14.5px] text-foreground">
				{label}
			</label>
			{showingSecret ? (
				<>
					<span
						id={id}
						className="min-w-0 flex-1 truncate font-mono text-[13.5px] text-muted-foreground"
					>
						{savedDisplay}
					</span>
					<button
						type="button"
						onClick={() => setReplacing(true)}
						disabled={disabled}
						className="focus-ring shrink-0 rounded-md font-medium text-link text-sm"
					>
						Replace
					</button>
					{onRemove && (
						<button
							type="button"
							onClick={onRemove}
							disabled={disabled}
							className="focus-ring shrink-0 rounded-md font-medium text-destructive-text text-sm"
						>
							Remove
						</button>
					)}
				</>
			) : (
				<input
					id={id}
					type={secret ? "password" : "text"}
					autoComplete="off"
					spellCheck={false}
					value={draft}
					placeholder={placeholder}
					disabled={disabled}
					onChange={(event) => setDraft(event.target.value)}
					onBlur={commit}
					onKeyDown={(event) => {
						if (event.key === "Enter") event.currentTarget.blur();
						if (event.key === "Escape") {
							setDraft(secret ? "" : (saved ?? ""));
							setReplacing(false);
						}
					}}
					className="min-w-0 flex-1 rounded-md bg-transparent font-mono text-[13.5px] text-foreground outline-none placeholder:text-subtle-foreground focus-visible:shadow-(--ring-shadow)"
				/>
			)}
		</div>
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
): string | undefined {
	if (latest) {
		return latest.reachable
			? `Search works: ${latest.results ?? 0} results in ${latest.latencyMs} ms.`
			: (latest.error ?? "The search did not work.");
	}
	if (provider?.status === "connected") return "The last test search worked.";
	if (provider?.status === "error") return provider.lastTestError ?? "The last test search failed.";
	return undefined;
}
