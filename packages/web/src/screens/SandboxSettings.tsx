import {
	DEFAULT_SANDBOX_ALLOWED_HOSTS,
	DEFAULT_SANDBOX_PRESET,
	type SandboxIsolation,
	type SandboxProvider,
	type SandboxProviderUpdate,
	sandboxIsolationSchema,
	sandboxProviderCatalog,
	sandboxProviderPreset,
	sandboxProviderPresetIdSchema,
} from "@sugabots/contracts";
import { Schema } from "effect";
import { type ReactNode, useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { useSandboxProvider, useSandboxProviderActions } from "@/lib/sandbox-provider.ts";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { Input } from "@/ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select.tsx";
import { Textarea } from "@/ui/textarea.tsx";
import { Toggle } from "@/ui/toggle.tsx";

/*
 * Where a workspace's pods get their sandboxes: one card, laid out like web
 * search's. The switch offers sandbox tools to the agents an admin has allowed
 * a sandbox; below it, which service makes them, its address and key, the
 * image sandboxes start from, how they are isolated, and which hosts they may
 * reach. Until the workspace has saved anything, the rows show the chosen
 * preset's defaults, and the first thing saved sets the provider up. The
 * switch stays off until the service has a key.
 */

export function SandboxSettings() {
	const provider = useSandboxProvider();
	if (provider.isPending) return null;
	if (provider.isError) return <Alert>{failureMessage(provider.error)}</Alert>;
	return (
		<SandboxCard
			provider={provider.data.provider}
			allowsUnisolated={provider.data.allowsUnisolated}
		/>
	);
}

function SandboxCard({
	provider,
	allowsUnisolated,
}: {
	provider: SandboxProvider | null;
	allowsUnisolated: boolean;
}) {
	const actions = useSandboxProviderActions();
	const chosen = provider?.preset ?? DEFAULT_SANDBOX_PRESET;
	const preset = sandboxProviderPreset(chosen);
	const [error, setError] = useState<string>();
	const pending = actions.replace.isPending || actions.update.isPending || actions.test.isPending;
	const hasApiKey = provider?.hasApiKey ?? false;

	async function act(work: () => Promise<unknown>) {
		setError(undefined);
		try {
			await work();
		} catch (cause) {
			setError(failureMessage(cause));
		}
	}

	/** Changes the provider, or sets it up with this change when the workspace has none yet. */
	function save(change: Omit<SandboxProviderUpdate, "apiKey"> & { apiKey?: string }) {
		return act(() =>
			provider
				? actions.update.mutateAsync(change)
				: actions.replace.mutateAsync({ preset: chosen, ...change }),
		);
	}

	return (
		<section
			aria-label="Sandboxes"
			className="flex max-w-2xl flex-col rounded-2xl border border-border bg-card px-5"
		>
			<Row
				title="Sandboxes"
				description="Gives each pod a Linux machine, where agents you allow can run commands and edit files."
				heading
				control={
					<Toggle
						checked={provider?.enabled ?? false}
						disabled={!hasApiKey || pending}
						label={provider?.enabled ? "Turn sandboxes off" : "Turn sandboxes on"}
						onChange={(enabled) => save({ enabled })}
					/>
				}
			/>
			<Row
				title="Sandbox provider"
				description="Choose the service that runs the pods' sandboxes."
				control={
					<Select
						value={chosen}
						items={providerLabels}
						onValueChange={(value) => {
							if (Schema.is(sandboxProviderPresetIdSchema)(value) && value !== chosen) {
								act(() => actions.replace.mutateAsync({ preset: value, enabled: false }));
							}
						}}
						disabled={pending}
					>
						<SelectTrigger aria-label="Sandbox provider" className="w-48">
							<SelectValue />
						</SelectTrigger>
						<SelectContent alignItemWithTrigger={false} align="end">
							{sandboxProviderCatalog.map((candidate) => (
								<SelectItem key={candidate.id} value={candidate.id}>
									{candidate.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				}
			/>
			<TextRow
				title="Server URL"
				description={`Where this API reaches your ${preset.name} server.`}
				value={provider?.baseUrl ?? preset.baseUrl}
				pending={pending}
				save={(baseUrl) => save({ baseUrl })}
			/>
			<ApiKeyRow
				name={preset.name}
				hasApiKey={hasApiKey}
				status={provider ? testStanding(provider, actions.test.data) : undefined}
				pending={pending}
				save={(apiKey) => save({ apiKey })}
				test={() => act(() => actions.test.mutateAsync())}
			/>
			<TextRow
				title="Image"
				description="The container image each pod's sandbox starts from. It needs bash and useradd."
				value={provider?.image ?? preset.defaultImage}
				pending={pending}
				save={(image) => save({ image })}
			/>
			<IsolationRow
				isolation={provider?.isolation ?? "gvisor"}
				allowsUnisolated={allowsUnisolated}
				pending={pending}
				save={(isolation) => save({ isolation })}
			/>
			<AllowedHostsRow
				hosts={provider?.allowedHosts ?? DEFAULT_SANDBOX_ALLOWED_HOSTS}
				pending={pending}
				save={(allowedHosts) => save({ allowedHosts })}
			/>
			{error && <Alert className="mb-4">{error}</Alert>}
		</section>
	);
}

const providerLabels: Record<string, string> = Object.fromEntries(
	sandboxProviderCatalog.map((preset) => [preset.id, preset.name]),
);

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

function TextRow({
	title,
	description,
	value,
	pending,
	save,
}: {
	title: string;
	description: string;
	value: string;
	pending: boolean;
	save: (value: string) => void;
}) {
	const [draft, setDraft] = useState(value);
	const changed = draft.trim() !== value && draft.trim() !== "";
	return (
		<Row title={title} description={description}>
			<form
				className="flex gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					if (changed) save(draft.trim());
				}}
			>
				<Input
					aria-label={title}
					className="min-w-0 flex-1 font-mono"
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
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
	name,
	hasApiKey,
	status,
	pending,
	save,
	test,
}: {
	name: string;
	hasApiKey: boolean;
	/** What the last test said, once one has run. */
	status?: string;
	pending: boolean;
	save: (apiKey: string) => Promise<void> | void;
	test: () => void;
}) {
	const [apiKey, setApiKey] = useState("");
	const [replacing, setReplacing] = useState(false);
	const editing = replacing || !hasApiKey;
	return (
		<Row
			title={`${name} API key`}
			description={status ?? "Required. The server's api_key setting."}
		>
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
						aria-label={`${name} API key`}
						className="min-w-0 flex-1 font-mono"
						type="password"
						autoComplete="off"
						value={apiKey}
						onChange={(event) => setApiKey(event.target.value)}
						placeholder={`Enter your ${name} API key`}
						disabled={pending}
					/>
					<Button type="submit" disabled={!apiKey || pending}>
						Save key
					</Button>
					{hasApiKey && (
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
						Test connection
					</Button>
				</div>
			)}
		</Row>
	);
}

const isolationLabels: Record<SandboxIsolation, string> = {
	gvisor: "gVisor",
	microvm: "MicroVM",
	container: "Container (shares the host kernel)",
};

function IsolationRow({
	isolation,
	allowsUnisolated,
	pending,
	save,
}: {
	isolation: SandboxIsolation;
	allowsUnisolated: boolean;
	pending: boolean;
	save: (isolation: SandboxIsolation) => void;
}) {
	const choices = sandboxIsolationSchema.literals.filter(
		(choice) => choice !== "container" || allowsUnisolated || isolation === "container",
	);
	return (
		<Row
			title="Isolation"
			description="What the server runs sandboxes with. It can't report this, so say what it's set up for."
			control={
				<Select
					value={isolation}
					items={isolationLabels}
					onValueChange={(value) => {
						if (Schema.is(sandboxIsolationSchema)(value) && value !== isolation) save(value);
					}}
					disabled={pending}
				>
					<SelectTrigger aria-label="Isolation" className="w-64">
						<SelectValue />
					</SelectTrigger>
					<SelectContent alignItemWithTrigger={false} align="end">
						{choices.map((choice) => (
							<SelectItem key={choice} value={choice}>
								{isolationLabels[choice]}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			}
		/>
	);
}

function AllowedHostsRow({
	hosts,
	pending,
	save,
}: {
	hosts: readonly string[];
	pending: boolean;
	save: (hosts: string[]) => void;
}) {
	const saved = hosts.join("\n");
	const [draft, setDraft] = useState(saved);
	const parsed = draft
		.split(/[\s,]+/)
		.map((host) => host.trim())
		.filter((host) => host.length > 0);
	const changed = parsed.join("\n") !== saved;
	return (
		<Row
			title="Allowed hosts"
			description="What sandboxes may reach, one per line. *.example.com covers its subdomains; * alone allows anywhere. Changes reach running sandboxes too, except switching to or from *, which only new sandboxes get."
		>
			<form
				className="flex flex-col gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					if (changed) save(parsed);
				}}
			>
				<Textarea
					aria-label="Allowed hosts"
					className="min-h-32 font-mono"
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					disabled={pending}
				/>
				<div>
					<Button type="submit" variant="secondary" disabled={!changed || pending}>
						Save
					</Button>
				</div>
			</form>
		</Row>
	);
}

/** The key row's line once a test has run, or what the provider recorded; otherwise nothing. */
function testStanding(
	provider: SandboxProvider,
	latest: { reachable: boolean; latencyMs: number; error?: string } | undefined,
): string | undefined {
	if (latest) {
		return latest.reachable
			? `Connected in ${latest.latencyMs} ms.`
			: (latest.error ?? "The server could not be reached.");
	}
	if (provider.status === "connected") return "The last test connected.";
	if (provider.status === "error") return provider.lastTestError ?? "The last test failed.";
	return undefined;
}
