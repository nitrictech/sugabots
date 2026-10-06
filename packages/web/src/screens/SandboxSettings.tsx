import {
	type SandboxProvider,
	type SandboxProviderPresetId,
	type SandboxProviderSettings,
	type SandboxProviderTestResult,
	type SandboxProviderUpdate,
	sandboxProviderCatalog,
	sandboxProviderPreset,
} from "@sugabots/contracts";
import { Check } from "lucide-react";
import { useId, useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import {
	usePrepareSandboxTemplate,
	useSandboxProviderActions,
	useSandboxProviders,
	useSandboxTemplate,
} from "@/lib/sandbox-providers.ts";
import { Alert } from "@/ui/alert.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import { SettingsGroup, SettingsRow, SettingsRowIcon, SettingsValue } from "@/ui/settings-page.tsx";
import { Toggle } from "@/ui/toggle.tsx";
import { SandboxNetworkSection } from "./SandboxNetworkSettings.tsx";
import { TextEntryRow } from "./text-entry-row.tsx";

/*
 * The workspace's sandbox settings, experimental: a switch for whether bots
 * get a Linux machine per pod to run commands on, which provider makes those
 * machines, and that provider's account. A workspace may keep a provider
 * configured for each preset; the switch enables the chosen one, which
 * disables any other.
 */

/** What each provider is good for, in the line under its name. */
const providerDescriptions: Record<SandboxProviderPresetId, string> = {
	opensandbox: "Runs on your own Docker or Kubernetes",
	e2b: "Hosted microVMs, or E2B Embed on your own server",
	cloudflare: "Containers in your Cloudflare account, through a Worker you deploy",
};

export function SandboxSettings() {
	const providers = useSandboxProviders();
	if (providers.isPending) return null;
	if (providers.isError) return <Alert>{failureMessage(providers.error)}</Alert>;
	return <SandboxGroups providers={providers.data} />;
}

function SandboxGroups({ providers }: { providers: readonly SandboxProvider[] }) {
	const actions = useSandboxProviderActions();
	const enabled = providers.find((provider) => provider.enabled);
	const [chosen, setChosen] = useState<SandboxProviderPresetId>(
		enabled?.preset ?? providers[0]?.preset ?? "opensandbox",
	);
	const [error, setError] = useState<string>();
	const configured = providers.find((provider) => provider.preset === chosen);
	const preset = sandboxProviderPreset(chosen);
	const pending =
		actions.create.isPending ||
		actions.update.isPending ||
		actions.test.isPending ||
		actions.remove.isPending;
	// OpenSandbox starts with its usual address; Cloudflare's Worker has none until it's given.
	const ready =
		configured?.hasApiKey === true &&
		(configured.settings.preset !== "cloudflare" || configured.settings.workerUrl !== undefined);

	async function act(work: () => Promise<unknown>) {
		setError(undefined);
		try {
			await work();
		} catch (cause) {
			setError(failureMessage(cause));
		}
	}

	/** Changes the chosen provider's settings, setting it up first when it has none. */
	function configure(changes: SandboxProviderUpdate) {
		return act(() =>
			configured
				? actions.update.mutateAsync({ providerId: configured.id, changes })
				: actions.create.mutateAsync({
						settings: changes.settings ?? { preset: chosen },
						enabled: changes.enabled,
						apiKey: changes.apiKey ?? undefined,
					}),
		);
	}

	function switchTo(on: boolean) {
		if (on) return configure({ enabled: true });
		if (!enabled) return Promise.resolve();
		return act(() =>
			actions.update.mutateAsync({ providerId: enabled.id, changes: { enabled: false } }),
		);
	}

	return (
		<>
			<Alert>
				Sandboxes are experimental. How they work, and what they keep, may change between releases.
			</Alert>
			<SettingsGroup
				note={
					!ready
						? chosen === "cloudflare"
							? "Cloudflare needs its Worker's address and API key first. Add them below."
							: `${preset.name} needs an API key first. Add it below.`
						: enabled && enabled.preset !== chosen
							? `Turning this on moves sandboxes from ${enabled.name} to ${preset.name}. Each pod gets a new one, without the old one's files.`
							: undefined
				}
			>
				<SettingsRow
					label="Bots can use a sandbox"
					sub="A Linux machine for each pod, to run commands and edit files"
					trailing={
						<Toggle
							checked={enabled?.preset === chosen}
							disabled={!ready || pending}
							label="Bots can use a sandbox"
							onChange={(next) => void switchTo(next)}
						/>
					}
				/>
			</SettingsGroup>
			<ProviderChoice
				chosen={chosen}
				enabled={enabled?.preset}
				disabled={pending}
				onChoose={(next) => {
					setError(undefined);
					setChosen(next);
				}}
			/>
			<ProviderSettings
				key={chosen}
				chosen={chosen}
				provider={configured}
				pending={pending}
				testResult={
					configured && actions.test.data && actions.test.variables === configured.id
						? actions.test.data
						: undefined
				}
				onConfigure={configure}
				onTest={() => configured && act(() => actions.test.mutateAsync(configured.id))}
				onRemove={async () => {
					if (configured) await actions.remove.mutateAsync(configured.id);
				}}
			/>
			{error && <Alert>{error}</Alert>}
			<SandboxNetworkSection />
		</>
	);
}

/** The providers as one pick-one list: the one being configured ticked, the enabled one marked. */
function ProviderChoice({
	chosen,
	enabled,
	disabled,
	onChoose,
}: {
	chosen: SandboxProviderPresetId;
	enabled: SandboxProviderPresetId | undefined;
	disabled: boolean;
	onChoose: (preset: SandboxProviderPresetId) => void;
}) {
	const name = useId();
	return (
		<fieldset className="m-0 flex min-w-0 flex-col border-0 p-0" disabled={disabled}>
			<legend className="px-1 pb-2 font-medium text-sm text-subtle-foreground">Provider</legend>
			<div className="overflow-hidden rounded-panel bg-list">
				{sandboxProviderCatalog.map((candidate) => (
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
								{candidate.id === enabled && (
									<span className="ml-2 font-normal text-muted-foreground text-sm">In use</span>
								)}
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

/** The chosen provider's account: where it is, its key, what sandboxes are made from. */
function ProviderSettings({
	chosen,
	provider,
	pending,
	testResult,
	onConfigure,
	onTest,
	onRemove,
}: {
	chosen: SandboxProviderPresetId;
	provider: SandboxProvider | undefined;
	pending: boolean;
	testResult: SandboxProviderTestResult | undefined;
	onConfigure: (changes: SandboxProviderUpdate) => Promise<void>;
	onTest: () => void;
	onRemove: () => Promise<unknown>;
}) {
	const preset = sandboxProviderPreset(chosen);
	const settings: SandboxProviderSettings = provider?.settings ?? { preset: chosen };
	const image = preset.image;
	const [removingKey, setRemovingKey] = useState(false);
	const [removing, setRemoving] = useState(false);
	const [removeError, setRemoveError] = useState<string>();
	const hasKey = provider?.hasApiKey === true;

	return (
		<SettingsGroup label={preset.name} note={testStanding(provider, testResult) ?? hint(chosen)}>
			{settings.preset === "opensandbox" && (
				<TextEntryRow
					label="Server URL"
					saved={settings.serverUrl ?? preset.baseUrl}
					placeholder={preset.baseUrl ?? ""}
					disabled={pending}
					onSave={(serverUrl) => onConfigure({ settings: { ...settings, serverUrl } })}
				/>
			)}
			{settings.preset === "cloudflare" && (
				<TextEntryRow
					label="Worker URL"
					saved={settings.workerUrl}
					placeholder="https://sugabots-sandboxes.example.workers.dev"
					disabled={pending}
					onSave={(workerUrl) => onConfigure({ settings: { ...settings, workerUrl } })}
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
			{settings.preset === "opensandbox" && image && (
				<TextEntryRow
					label={image.label}
					saved={settings.image}
					placeholder={image.default}
					disabled={pending}
					clearable
					onSave={(image) => onConfigure({ settings: { ...settings, image: image || undefined } })}
				/>
			)}
			{settings.preset === "e2b" && image && (
				<>
					<TextEntryRow
						label={image.label}
						saved={settings.template}
						placeholder={image.default}
						disabled={pending}
						clearable
						onSave={(template) =>
							onConfigure({ settings: { ...settings, template: template || undefined } })
						}
					/>
					<TextEntryRow
						label="API URL"
						saved={settings.apiUrl}
						placeholder="E2B Cloud"
						disabled={pending}
						clearable
						onSave={(apiUrl) =>
							onConfigure({ settings: { ...settings, apiUrl: apiUrl || undefined } })
						}
					/>
					<TextEntryRow
						label="Sandbox URL"
						saved={settings.sandboxUrl}
						placeholder="E2B Cloud"
						disabled={pending}
						clearable
						onSave={(sandboxUrl) =>
							onConfigure({ settings: { ...settings, sandboxUrl: sandboxUrl || undefined } })
						}
					/>
				</>
			)}
			{chosen === "e2b" && provider && hasKey && <TemplateRow providerId={provider.id} />}
			{provider && hasKey && (
				<SettingsRow
					label="Test connection"
					sub="Checks the provider answers and accepts the key."
					onClick={pending ? undefined : onTest}
				/>
			)}
			{provider && (
				<SettingsRow
					label={`Remove ${preset.name}`}
					sub="Removes its sandboxes and settings."
					onClick={pending ? undefined : () => setRemoving(true)}
				/>
			)}
			<DeleteDialog
				open={removingKey}
				onOpenChange={setRemovingKey}
				title={`Remove the ${preset.name} key?`}
				description="Bots stop getting sandboxes from this provider until another key is added."
				confirmLabel="Remove"
				pending={pending}
				onDelete={async () => {
					await onConfigure({ apiKey: null });
					setRemovingKey(false);
				}}
			/>
			<DeleteDialog
				open={removing}
				onOpenChange={(open) => {
					setRemoving(open);
					setRemoveError(undefined);
				}}
				title={`Remove ${preset.name}?`}
				description={
					removeError ??
					"Every pod's sandbox at this provider is destroyed, with its files, including work that wasn't pushed."
				}
				confirmLabel="Remove"
				pending={pending}
				onDelete={async () => {
					try {
						await onRemove();
						setRemoving(false);
					} catch (cause) {
						setRemoveError(failureMessage(cause));
					}
				}}
			/>
		</SettingsGroup>
	);
}

/**
 * E2B makes sandboxes from a template, built in the workspace's own E2B
 * account from Sugabots' sandbox image. Until it is, sandboxes can't be made;
 * once it is, it can be rebuilt to take a newer image.
 */
function TemplateRow({ providerId }: { providerId: string }) {
	const template = useSandboxTemplate(providerId);
	const prepare = usePrepareSandboxTemplate(providerId);
	const state = template.data?.state;
	const canPrepare = state === "missing" || state === "failed" || state === "ready";
	return (
		<SettingsRow
			label={
				state === "ready"
					? "Rebuild template"
					: canPrepare
						? "Prepare template"
						: "Sugabots template"
			}
			sub={
				prepare.error
					? failureMessage(prepare.error)
					: template.error
						? failureMessage(template.error)
						: state === "ready"
							? "Ready. Rebuilding takes Sugabots' latest image, which pods' sandboxes move to when upgraded."
							: state === "building"
								? "Building in your E2B account. This takes a few minutes."
								: state === "failed"
									? "The last build failed. Try again."
									: "Builds Sugabots' sandbox image into a template in your E2B account."
			}
			trailing={
				state === "ready" || state === "building" ? (
					<SettingsValue>{state === "ready" ? "Ready" : "Building"}</SettingsValue>
				) : undefined
			}
			onClick={canPrepare && !prepare.isPending ? () => prepare.mutate() : undefined}
		/>
	);
}

function hint(preset: SandboxProviderPresetId): string {
	switch (preset) {
		case "opensandbox":
			return "The server's own API key, from its configuration. Leave the image empty to use the default.";
		case "e2b":
			return "Leave the URLs empty for E2B Cloud. For E2B Embed, give both.";
		case "cloudflare":
			return "Deploy Sugabots' sandbox Worker to your Cloudflare account, then give its address and its API_KEY secret. Deploying it again moves new sandboxes to the latest image.";
	}
}

/** What the last test said, once one has run, or what the provider recorded. */
function testStanding(
	provider: SandboxProvider | undefined,
	latest: SandboxProviderTestResult | undefined,
): string | undefined {
	if (latest) {
		return latest.reachable
			? `Connected in ${latest.latencyMs} ms.`
			: (latest.error ?? "The provider didn't answer.");
	}
	if (provider?.status === "connected") return "The last test connected.";
	if (provider?.status === "error") return provider.lastTestError ?? "The last test failed.";
	return undefined;
}
