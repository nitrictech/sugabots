import {
	SANDBOX_DEFAULT_SIZE,
	SANDBOX_NETWORK_MODE_DEFAULT,
	type SandboxNetworkMode,
	type SandboxProvider,
	type SandboxProviderPresetId,
	type SandboxProviderSettings,
	type SandboxProviderTestResult,
	type SandboxProviderUpdate,
	sandboxCpuCountSchema,
	sandboxMemoryGiBSchema,
	sandboxProviderCatalog,
	sandboxProviderPreset,
} from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { Schema } from "effect";
import { useId, useState } from "react";
import { useAgents } from "@/lib/agents.ts";
import { failureMessage } from "@/lib/failure.ts";
import { agentSettingsLink } from "@/lib/links.ts";
import { usePods } from "@/lib/pods.ts";
import {
	usePrepareSandboxTemplate,
	useSandboxProviderActions,
	useSandboxProviders,
	useSandboxTemplate,
} from "@/lib/sandbox-providers.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { Alert } from "@/ui/alert.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import { Note } from "@/ui/note.tsx";
import { SegmentedControl } from "@/ui/segmented-control.tsx";
import {
	SETTINGS_CARD,
	SETTINGS_RADIO_ROW,
	SettingsGroup,
	SettingsRadioMark,
	SettingsRow,
	SettingsRowIcon,
	SettingsValue,
} from "@/ui/settings-page.tsx";
import { Toggle } from "@/ui/toggle.tsx";
import { SandboxNetworkSection } from "./SandboxNetworkSettings.tsx";
import { TextEntryRow } from "./text-entry-row.tsx";

/*
 * The workspace's computers, experimental: a switch for whether bots get a
 * Linux computer per pod to run commands on, which provider makes those
 * computers, that provider's account, what the computers may reach, and the
 * bots using one. A workspace may keep a provider configured for each preset;
 * the switch enables the chosen one, which disables any other. Code calls a
 * computer a sandbox; people read "computer".
 */

const networkModes: readonly { value: SandboxNetworkMode; label: string }[] = [
	{ value: "open", label: "Open" },
	{ value: "allowlist", label: "Allowlist" },
];

/** What each provider is good for, in the line under its name. */
const providerDescriptions: Record<SandboxProviderPresetId, string> = {
	opensandbox: "Runs on your own Docker or Kubernetes",
	e2b: "Hosted microVMs, or E2B Embed on your own server",
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
	const ready = configured?.hasApiKey === true;

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

	const settings: SandboxProviderSettings = configured?.settings ?? { preset: chosen };

	return (
		<>
			<Note className="-mt-6 rounded-xl border border-settings-card-border bg-settings-card text-[13px]">
				Computers are experimental. How they work, and what they keep, may change between releases.
			</Note>
			<SettingsGroup
				note={
					ready && enabled && enabled.preset !== chosen
						? `Turning this on moves computers from ${enabled.name} to ${preset.name}. Each pod gets a new one, without the old one's files.`
						: undefined
				}
			>
				<SettingsRow
					label={<span className="font-medium">Bots can use a computer</span>}
					sub={
						ready
							? "Each pod gets its own private computer"
							: `${preset.name} needs an API key first. Add it below.`
					}
					trailing={
						<Toggle
							checked={enabled?.preset === chosen}
							disabled={!ready || pending}
							label="Bots can use a computer"
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
				onInvalid={setError}
				onTest={() => configured && act(() => actions.test.mutateAsync(configured.id))}
				onRemove={async () => {
					if (configured) await actions.remove.mutateAsync(configured.id);
				}}
			/>
			{error && <Alert>{error}</Alert>}
			<SandboxNetworkSection
				modeRow={
					<SettingsRow
						label={
							<span className="font-medium">
								{(settings.networkMode ?? SANDBOX_NETWORK_MODE_DEFAULT) === "allowlist"
									? "Allowlist"
									: "Open"}
							</span>
						}
						sub={networkSummary(settings)}
						trailing={
							<SegmentedControl
								label="Network"
								options={networkModes}
								value={settings.networkMode ?? SANDBOX_NETWORK_MODE_DEFAULT}
								disabled={pending}
								onChange={(networkMode) =>
									void configure({ settings: { ...settings, networkMode } })
								}
							/>
						}
					/>
				}
			/>
			<BotsUsingAComputer />
		</>
	);
}

/**
 * The bots with their computer switched on, each opening its own settings,
 * where that switch is. A bot can have one only while the workspace does, so
 * the list says so when there is none.
 */
function BotsUsingAComputer() {
	const { agents } = useAgents();
	const { data: pods } = usePods();
	const podById = new Map(pods?.map((pod) => [pod.id, pod]));
	const using = (agents ?? []).flatMap((agent) => {
		const pod = podById.get(agent.podId);
		return agent.usesSandbox && agent.systemAgentKey === null && pod ? [{ agent, pod }] : [];
	});
	if (!agents || !pods) return null;
	return (
		<SettingsGroup
			label="Bots using a computer"
			note="Switch a computer on or off in each bot's settings."
		>
			{using.length === 0 && (
				<SettingsRow label={<span className="text-muted-foreground">None yet</span>} />
			)}
			{using.map(({ agent, pod }) => (
				<SettingsRow
					key={agent.id}
					icon={<AgentAvatar color={agent.color} face={agent.face} shape={agent.shape} size={24} />}
					label={agent.name}
					sub={pod.name}
					chevron
					render={<Link {...agentSettingsLink({ pod, agent })} />}
				/>
			))}
		</SettingsGroup>
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
			<legend className="px-0.5 pb-2.5 font-medium text-[13px] text-muted-foreground">
				Provider
			</legend>
			<div className={SETTINGS_CARD}>
				{sandboxProviderCatalog.map((candidate) => (
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
								{candidate.id === enabled && (
									<span className="ml-2 font-normal text-subtle-foreground text-xs">In use</span>
								)}
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

/** The chosen provider's account: where it is, its key, what computers are made from. */
function ProviderSettings({
	chosen,
	provider,
	pending,
	testResult,
	onConfigure,
	onInvalid,
	onTest,
	onRemove,
}: {
	chosen: SandboxProviderPresetId;
	provider: SandboxProvider | undefined;
	pending: boolean;
	testResult: SandboxProviderTestResult | undefined;
	onConfigure: (changes: SandboxProviderUpdate) => Promise<void>;
	/** Says why a typed value can't be saved. */
	onInvalid: (message: string) => void;
	onTest: () => void;
	onRemove: () => Promise<unknown>;
}) {
	const preset = sandboxProviderPreset(chosen);
	const settings: SandboxProviderSettings = provider?.settings ?? { preset: chosen };
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
			<TextEntryRow
				label="API key"
				secret
				saved={hasKey ? "" : undefined}
				placeholder="Paste your key"
				disabled={pending}
				onSave={(apiKey) => onConfigure({ apiKey })}
				onRemove={hasKey ? () => setRemovingKey(true) : undefined}
			/>
			{settings.preset === "opensandbox" && (
				<TextEntryRow
					label={preset.imageLabel}
					saved={settings.image}
					placeholder={preset.defaultImage}
					disabled={pending}
					clearable
					onSave={(image) => onConfigure({ settings: { ...settings, image: image || undefined } })}
				/>
			)}
			{settings.preset === "e2b" && (
				<>
					<TextEntryRow
						label={preset.imageLabel}
						saved={settings.template}
						placeholder={preset.defaultImage}
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
						label="Computer URL"
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
			<TextEntryRow
				label="vCPUs"
				saved={settings.cpuCount?.toString()}
				placeholder={String(SANDBOX_DEFAULT_SIZE.cpuCount)}
				disabled={pending}
				clearable
				onSave={(typed) => {
					const cpuCount = wholeNumber(typed);
					if (typed && !Schema.is(sandboxCpuCountSchema)(cpuCount)) {
						onInvalid("Enter a whole number of vCPUs, from 1 to 64.");
						return Promise.resolve();
					}
					return onConfigure({ settings: { ...settings, cpuCount } });
				}}
			/>
			<TextEntryRow
				label="Memory"
				saved={settings.memoryGiB === undefined ? undefined : `${settings.memoryGiB} GiB`}
				placeholder={`${SANDBOX_DEFAULT_SIZE.memoryGiB} GiB`}
				disabled={pending}
				clearable
				onSave={(typed) => {
					const memoryGiB = wholeNumber(typed.replace(/\s*GiB$/i, ""));
					if (typed && !Schema.is(sandboxMemoryGiBSchema)(memoryGiB)) {
						onInvalid("Enter a whole number of GiB, from 1 to 64.");
						return Promise.resolve();
					}
					return onConfigure({ settings: { ...settings, memoryGiB } });
				}}
			/>
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
					sub="Removes its computers and settings."
					onClick={pending ? undefined : () => setRemoving(true)}
				/>
			)}
			<DeleteDialog
				open={removingKey}
				onOpenChange={setRemovingKey}
				title={`Remove the ${preset.name} key?`}
				description="Bots stop getting computers from this provider until another key is added."
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
					"Every pod's computer at this provider is destroyed, with its files, including work that wasn't pushed."
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
 * E2B makes computers from a template, built in the workspace's own E2B
 * account from Sugabots' computer image. Until it is, computers can't be made;
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
							? "Ready. Rebuilding takes Sugabots' latest image, which pods' computers move to when upgraded."
							: state === "building"
								? "Building in your E2B account. This takes a few minutes."
								: state === "failed"
									? "The last build failed. Try again."
									: "Builds Sugabots' computer image into a template in your E2B account."
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

/** What the provider's computers reach. E2B can't refuse hosts by name, so open, it blocks nothing. */
function networkSummary(settings: SandboxProviderSettings): string {
	if ((settings.networkMode ?? SANDBOX_NETWORK_MODE_DEFAULT) === "allowlist") {
		return "Only the hosts allowed";
	}
	return settings.preset === "e2b"
		? "Any host. E2B can't block hosts"
		: "Any host but the blocked ones";
}

function hint(preset: SandboxProviderPresetId): string {
	return preset === "opensandbox"
		? "The server's own API key, from its configuration. Leave the image empty to use the default. A new size takes effect when a pod's computer is reset; on Kubernetes, one too big for any node never starts."
		: "Leave the URLs empty for E2B Cloud. For E2B Embed, give both. A new size takes effect once the template is prepared again and a pod's computer is reset.";
}

/** A number typed into a row, or undefined when the row was emptied. */
function wholeNumber(typed: string): number | undefined {
	return typed === "" ? undefined : Number(typed);
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
