import {
	DEFAULT_SEARCH_PRESET,
	type SearchProvider,
	searchProviderCatalog,
	searchProviderPreset,
	searchProviderPresetIdSchema,
} from "@sugabots/contracts";
import { Schema } from "effect";
import { type ReactNode, useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { useSearchProvider, useSearchProviderActions } from "@/lib/search-provider.ts";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { Input } from "@/ui/input.tsx";
import { SearchProviderMark } from "@/ui/search-provider-mark.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select.tsx";
import { Toggle } from "@/ui/toggle.tsx";

/*
 * Where a workspace's agents search from: one card, four settings at most.
 * The switch gives every agent the `web_search` tool; below it, who answers,
 * their address when it is a server you run, and their key. Exa is the
 * provider until another is chosen, and its key is optional, so the switch
 * works on a fresh workspace; a provider that needs a key holds the switch
 * off until it has one.
 */

export function WebSearchSettings() {
	const provider = useSearchProvider();
	if (provider.isPending) return null;
	if (provider.isError) return <Alert>{failureMessage(provider.error)}</Alert>;
	return <WebSearchCard provider={provider.data ?? null} />;
}

function WebSearchCard({ provider }: { provider: SearchProvider | null }) {
	const actions = useSearchProviderActions();
	const chosen = provider?.preset ?? DEFAULT_SEARCH_PRESET;
	const preset = searchProviderPreset(chosen);
	const [error, setError] = useState<string>();
	const pending = actions.replace.isPending || actions.update.isPending || actions.test.isPending;
	const needsKey = preset?.requiresApiKey === true && provider?.hasApiKey === false;

	async function act(work: () => Promise<unknown>) {
		setError(undefined);
		try {
			await work();
		} catch (cause) {
			setError(failureMessage(cause));
		}
	}

	return (
		<section
			aria-label="Web search"
			className="flex max-w-2xl flex-col rounded-2xl border border-border bg-card px-5"
		>
			<Row
				title="Web search"
				description="Gives every agent in the workspace the web_search tool."
				heading
				control={
					<Toggle
						checked={provider?.enabled ?? false}
						disabled={needsKey || pending}
						label={provider?.enabled ? "Turn web search off" : "Turn web search on"}
						onChange={(enabled) =>
							act(() =>
								provider
									? actions.update.mutateAsync({ enabled })
									: actions.replace.mutateAsync({ preset: DEFAULT_SEARCH_PRESET, enabled }),
							)
						}
					/>
				}
			/>
			<Row
				title="Search provider"
				description="Choose the backend that answers web_search calls."
				control={
					<Select
						value={chosen}
						items={providerLabels}
						onValueChange={(value) => {
							if (Schema.is(searchProviderPresetIdSchema)(value) && value !== chosen) {
								act(() =>
									actions.replace.mutateAsync({
										preset: value,
										enabled: provider?.enabled ?? false,
									}),
								);
							}
						}}
						disabled={pending}
					>
						<SelectTrigger aria-label="Search provider" className="w-48">
							<SearchProviderMark preset={chosen} />
							<SelectValue />
						</SelectTrigger>
						<SelectContent alignItemWithTrigger={false} align="end">
							{searchProviderCatalog.map((candidate) => (
								<SelectItem key={candidate.id} value={candidate.id}>
									<span className="flex items-center gap-2">
										<SearchProviderMark preset={candidate.id} />
										{candidate.name}
									</span>
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				}
			/>
			{provider && preset.hosting === "local" && (
				<ServerUrlRow
					provider={provider}
					pending={pending}
					save={(baseUrl) => act(() => actions.update.mutateAsync({ baseUrl }))}
				/>
			)}
			{provider && (
				<ApiKeyRow
					provider={provider}
					keyHint={keyHint(provider)}
					status={testStanding(provider, actions.test.data)}
					pending={pending}
					save={(apiKey) => act(() => actions.update.mutateAsync({ apiKey }))}
					test={() => act(() => actions.test.mutateAsync())}
				/>
			)}
			{error && <Alert className="mb-4">{error}</Alert>}
		</section>
	);
}

const providerLabels: Record<string, string> = Object.fromEntries(
	searchProviderCatalog.map((preset) => [preset.id, preset.name]),
);

function keyHint(provider: SearchProvider): string {
	if (provider.preset === "exa") {
		return "Optional. Without one, searches use Exa's free tier, which is rate limited.";
	}
	return searchProviderPreset(provider.preset).requiresApiKey ? "Required." : "Optional.";
}

function Row({
	title,
	description,
	control,
	heading = false,
	children,
}: {
	title: string;
	description?: string;
	control?: ReactNode;
	/** The first row names the card; it has no rule above it and a larger title. */
	heading?: boolean;
	children?: ReactNode;
}) {
	return (
		<div className={`flex flex-col gap-2 py-4 ${heading ? "" : "border-border-subtle border-t"}`}>
			<div className="flex items-center gap-4">
				<div className="min-w-0 flex-1">
					<h3 className={`font-semibold text-heading ${heading ? "text-lg" : "text-md"}`}>
						{title}
					</h3>
					{description && <p className="text-muted-foreground text-sm">{description}</p>}
				</div>
				{control && <div className="shrink-0">{control}</div>}
			</div>
			{children}
		</div>
	);
}

function ServerUrlRow({
	provider,
	pending,
	save,
}: {
	provider: SearchProvider;
	pending: boolean;
	save: (baseUrl: string) => void;
}) {
	const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
	const changed = baseUrl.trim() !== provider.baseUrl;
	return (
		<Row title="Server URL" description="Where this API reaches your SearXNG.">
			<form
				className="flex gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					if (changed) save(baseUrl.trim());
				}}
			>
				<Input
					aria-label="Server URL"
					className="min-w-0 flex-1 font-mono"
					value={baseUrl}
					onChange={(event) => setBaseUrl(event.target.value)}
					disabled={pending}
				/>
				<Button type="submit" variant="secondary" disabled={!changed || pending}>
					Save
				</Button>
			</form>
		</Row>
	);
}

function ApiKeyRow({
	provider,
	keyHint,
	status,
	pending,
	save,
	test,
}: {
	provider: SearchProvider;
	keyHint: string;
	/** What the last test search said, once one has run. */
	status?: string;
	pending: boolean;
	save: (apiKey: string) => Promise<void> | void;
	test: () => void;
}) {
	const [apiKey, setApiKey] = useState("");
	const [replacing, setReplacing] = useState(false);
	const editing = replacing || !provider.hasApiKey;
	return (
		<Row title={`${provider.name} API key`} description={status ?? keyHint}>
			{editing ? (
				<form
					className="flex gap-2"
					onSubmit={async (event) => {
						event.preventDefault();
						if (!apiKey) return;
						await save(apiKey);
						setApiKey("");
						setReplacing(false);
					}}
				>
					<Input
						aria-label={`${provider.name} API key`}
						className="min-w-0 flex-1 font-mono"
						type="password"
						autoComplete="off"
						value={apiKey}
						onChange={(event) => setApiKey(event.target.value)}
						placeholder={`Enter your ${provider.name} API key`}
						disabled={pending}
					/>
					<Button type="submit" disabled={!apiKey || pending}>
						Save key
					</Button>
					{provider.hasApiKey && (
						<Button type="button" variant="ghost" onClick={() => setReplacing(false)}>
							Cancel
						</Button>
					)}
				</form>
			) : (
				<div className="flex items-center gap-3 text-sm">
					<code className="text-base text-foreground">••••••••</code>
					<Button size="bare" variant="link" onClick={() => setReplacing(true)}>
						Replace
					</Button>
					<span aria-hidden className="text-muted-foreground">
						·
					</span>
					<Button size="bare" variant="link" disabled={pending} onClick={test}>
						Test search
					</Button>
				</div>
			)}
		</Row>
	);
}

/** The key row's line once a test has run, or what the provider recorded; otherwise nothing. */
function testStanding(
	provider: SearchProvider,
	latest: { reachable: boolean; results?: number; latencyMs: number; error?: string } | undefined,
): string | undefined {
	if (latest) {
		return latest.reachable
			? `Search works: ${latest.results ?? 0} results in ${latest.latencyMs} ms.`
			: (latest.error ?? "The search did not work.");
	}
	if (provider.status === "connected") return "The last test search worked.";
	if (provider.status === "error") return provider.lastTestError ?? "The last test search failed.";
	return undefined;
}
