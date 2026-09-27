import {
	DEFAULT_SANDBOX_ALLOWED_HOSTS,
	DEFAULT_SANDBOX_PRESET,
	type SandboxIsolation,
	type SandboxProvider,
	type SandboxProviderPresetId,
	type SandboxProviderUpdate,
	sandboxIsolationSchema,
	sandboxProviderCatalog,
	sandboxProviderPreset,
} from "@sugabots/contracts";
import { Check } from "lucide-react";
import { useId, useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { useSandboxProvider, useSandboxProviderActions } from "@/lib/sandbox-provider.ts";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { SettingsGroup, SettingsRow } from "@/ui/settings-page.tsx";
import { Textarea } from "@/ui/textarea.tsx";
import { Toggle } from "@/ui/toggle.tsx";
import { TextEntryRow } from "./WebSearchSettings.tsx";

/*
 * Where a workspace's pods get their sandboxes, laid out like web search's. The
 * switch offers sandbox tools to the bots an admin has allowed a sandbox; below
 * it, which service makes them, its address and key, the image sandboxes start
 * from, how they are isolated, and which hosts they may reach. Until the
 * workspace has saved anything, the rows show the chosen preset's defaults, and
 * the first thing saved sets the provider up. The switch stays off until the
 * service has a key.
 */

export function SandboxSettings() {
	const provider = useSandboxProvider();
	if (provider.isPending) return null;
	if (provider.isError) return <Alert>{failureMessage(provider.error)}</Alert>;
	return (
		<SandboxGroups
			provider={provider.data.provider}
			allowsUnisolated={provider.data.allowsUnisolated}
		/>
	);
}

function SandboxGroups({
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

	const isolations = sandboxIsolationSchema.literals.filter(
		(choice) => choice !== "container" || allowsUnisolated || provider?.isolation === "container",
	);

	return (
		<>
			<SettingsGroup note={hasApiKey ? undefined : `${preset.name} needs an API key first.`}>
				<SettingsRow
					label="Bots can use sandboxes"
					sub="Each pod gets a Linux machine, where bots you allow run commands and edit files"
					trailing={
						<Toggle
							checked={provider?.enabled ?? false}
							disabled={!hasApiKey || pending}
							label="Bots can use sandboxes"
							onChange={(enabled) => save({ enabled })}
						/>
					}
				/>
			</SettingsGroup>
			<Choice
				legend="Provider"
				options={sandboxProviderCatalog.map((candidate) => ({
					value: candidate.id,
					label: candidate.name,
				}))}
				chosen={chosen}
				disabled={pending}
				onChoose={(next: SandboxProviderPresetId) =>
					act(() => actions.replace.mutateAsync({ preset: next, enabled: false }))
				}
			/>
			<SettingsGroup
				label={preset.name}
				note={
					(provider ? testStanding(provider, actions.test.data) : undefined) ??
					"The image needs bash and useradd."
				}
			>
				<TextEntryRow
					label="Server URL"
					saved={provider?.baseUrl ?? preset.baseUrl}
					placeholder={preset.baseUrl}
					disabled={pending}
					onSave={(baseUrl) => save({ baseUrl })}
				/>
				<TextEntryRow
					label="API key"
					secret
					saved={hasApiKey ? "" : undefined}
					savedDisplay={hasApiKey ? "••••••••" : undefined}
					placeholder="The server's api_key setting"
					disabled={pending}
					onSave={(apiKey) => save({ apiKey })}
				/>
				<TextEntryRow
					label="Image"
					saved={provider?.image ?? preset.defaultImage}
					placeholder={preset.defaultImage}
					disabled={pending}
					onSave={(image) => save({ image })}
				/>
				{provider && hasApiKey && (
					<SettingsRow
						label="Test connection"
						sub="Reaches the server with these settings."
						onClick={pending ? undefined : () => act(() => actions.test.mutateAsync())}
					/>
				)}
			</SettingsGroup>
			<Choice
				legend="Isolation"
				note="What the server runs sandboxes with. It can't report this, so say what it's set up for."
				options={isolations.map((choice) => ({ value: choice, label: isolationLabels[choice] }))}
				chosen={provider?.isolation ?? "gvisor"}
				disabled={pending}
				onChoose={(isolation: SandboxIsolation) => save({ isolation })}
			/>
			<AllowedHosts
				hosts={provider?.allowedHosts ?? DEFAULT_SANDBOX_ALLOWED_HOSTS}
				pending={pending}
				save={(allowedHosts) => save({ allowedHosts })}
			/>
			{error && <Alert>{error}</Alert>}
		</>
	);
}

const isolationLabels: Record<SandboxIsolation, string> = {
	gvisor: "gVisor",
	microvm: "MicroVM",
	container: "Container (shares the host kernel)",
};

/** A pick-one list, the chosen option ticked, laid out like web search's providers. */
function Choice<Value extends string>({
	legend,
	note,
	options,
	chosen,
	disabled,
	onChoose,
}: {
	legend: string;
	note?: string;
	options: ReadonlyArray<{ value: Value; label: string }>;
	chosen: Value;
	disabled: boolean;
	onChoose: (value: Value) => void;
}) {
	const name = useId();
	return (
		<fieldset className="m-0 flex min-w-0 flex-col border-0 p-0" disabled={disabled}>
			<legend className="px-1 pb-2 font-medium text-sm text-subtle-foreground">{legend}</legend>
			<div className="overflow-hidden rounded-panel bg-list">
				{options.map((option) => (
					<label
						key={option.value}
						className="flex cursor-pointer items-center gap-3 border-border border-b px-4 py-3 transition-colors last:border-b-0 hover:bg-panel has-focus-visible:shadow-(--ring-shadow) has-disabled:cursor-default"
					>
						<input
							type="radio"
							name={name}
							value={option.value}
							checked={option.value === chosen}
							onChange={() => {
								if (option.value !== chosen) onChoose(option.value);
							}}
							className="sr-only"
						/>
						<span className="min-w-0 flex-1 truncate font-medium text-[14.5px] text-foreground">
							{option.label}
						</span>
						{option.value === chosen && (
							<Check aria-hidden size={16} strokeWidth={2.4} className="shrink-0 text-link" />
						)}
					</label>
				))}
			</div>
			{note && <p className="m-0 px-1 pt-2 text-muted-foreground text-sm">{note}</p>}
		</fieldset>
	);
}

function AllowedHosts({
	hosts,
	pending,
	save,
}: {
	hosts: readonly string[];
	pending: boolean;
	save: (hosts: string[]) => void;
}) {
	const id = useId();
	const saved = hosts.join("\n");
	const [draft, setDraft] = useState(saved);
	const parsed = draft
		.split(/[\s,]+/)
		.map((host) => host.trim())
		.filter((host) => host.length > 0);
	const changed = parsed.join("\n") !== saved;
	return (
		<form
			className="flex flex-col gap-2"
			onSubmit={(event) => {
				event.preventDefault();
				if (changed) save(parsed);
			}}
		>
			<label htmlFor={id} className="px-1 font-medium text-sm text-subtle-foreground">
				Allowed hosts
			</label>
			<Textarea
				id={id}
				className="min-h-32 font-mono text-[13.5px]"
				value={draft}
				onChange={(event) => setDraft(event.target.value)}
				disabled={pending}
			/>
			<p className="m-0 px-1 text-muted-foreground text-sm">
				What sandboxes may reach, one per line. *.example.com covers its subdomains; * alone allows
				anywhere. Changes reach running sandboxes too, except switching to or from *, which only new
				sandboxes get.
			</p>
			<Button
				type="submit"
				variant="secondary"
				size="sm"
				disabled={!changed || pending}
				className="self-start"
			>
				Save hosts
			</Button>
		</form>
	);
}

/** What the last test said, once one has run, or what the provider recorded; otherwise nothing. */
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
