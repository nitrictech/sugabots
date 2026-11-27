import {
	type BuiltInComputerProviderId,
	builtInComputerProviders,
	COMPUTER_NETWORK_MODE_DEFAULT,
	type ComputerNetworkMode,
	type ComputerProvider,
	type ComputerProviderSettings,
	type ComputerProviderUpdate,
	computerBuiltInProvider,
	computerCpuCountSchema,
	computerDiskShare,
	computerMemoryGiBSchema,
	type ProviderTestResult,
} from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { Schema } from "effect";
import { useState } from "react";
import { useBots } from "@/lib/bots.ts";
import {
	useComputerDisks,
	useComputerProviderActions,
	useComputerProviders,
	useComputerTemplate,
	usePrepareComputerTemplate,
} from "@/lib/computer-providers.ts";
import { failureMessage } from "@/lib/failure.ts";
import { botSettingsLink } from "@/lib/links.ts";
import { useProjects } from "@/lib/projects.ts";
import { useProviderSettingsAction } from "@/lib/provider-settings-action.ts";
import { ownerLink, ownerName, type ResourceOwner } from "@/lib/resource-owner.tsx";
import { BotAvatar } from "@/shell/Bot.tsx";
import { Alert } from "@/ui/alert.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import { Note } from "@/ui/note.tsx";
import { SegmentedControl } from "@/ui/segmented-control.tsx";
import {
	SETTINGS_CARD,
	SettingsGroup,
	SettingsRadioList,
	SettingsRow,
	SettingsValue,
} from "@/ui/settings-page.tsx";
import { Toggle } from "@/ui/toggle.tsx";
import { DiskMeter, DiskPercent, diskSummary } from "./ComputerDisk.tsx";
import { ComputerNetworkSection } from "./ComputerNetworkSettings.tsx";
import { TextEntryRow } from "./text-entry-row.tsx";

/*
 * The workspace's computers, experimental: a switch for whether each project
 * gets a Linux computer its bots run commands on, a bot's being its default
 * project's, which provider makes those computers, that provider's account,
 * what the computers may reach, the bots using one, and how full each
 * computer's disk is. A workspace may keep a provider configured for each
 * built-in provider; the switch enables the chosen one, which disables any other.
 */

const networkModes: readonly { value: ComputerNetworkMode; label: string }[] = [
	{ value: "open", label: "Open" },
	{ value: "allowed-hosts-only", label: "Allowed hosts only" },
];

export function ComputerSettings() {
	const providers = useComputerProviders();
	if (providers.isPending) return null;
	if (providers.isError) return <Alert>{failureMessage(providers.error)}</Alert>;
	return <ComputerGroups providers={providers.data} />;
}

function ComputerGroups({ providers }: { providers: readonly ComputerProvider[] }) {
	const actions = useComputerProviderActions();
	const enabled = providers.find((provider) => provider.enabled);
	const [chosen, setChosen] = useState<BuiltInComputerProviderId>(
		enabled?.builtIn ?? providers[0]?.builtIn ?? "opensandbox",
	);
	const { error, setError, act } = useProviderSettingsAction();
	const configured = providers.find((provider) => provider.builtIn === chosen);
	const builtIn = computerBuiltInProvider(chosen);
	const pending =
		actions.create.isPending ||
		actions.update.isPending ||
		actions.test.isPending ||
		actions.remove.isPending;
	const ready = configured?.hasApiKey === true;

	/** Changes the chosen provider's settings, setting it up first when it has none. */
	function configure(changes: ComputerProviderUpdate) {
		return act(() =>
			configured
				? actions.update.mutateAsync({ providerId: configured.id, changes })
				: actions.create.mutateAsync({
						settings: changes.settings ?? { builtIn: chosen },
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

	const settings: ComputerProviderSettings = configured?.settings ?? { builtIn: chosen };

	return (
		<>
			<Note className={cn(SETTINGS_CARD, "-mt-6 text-xs")}>
				Computers are experimental. How they work, and what they keep, may change between releases.
			</Note>
			<SettingsGroup
				note={
					ready && enabled && enabled.builtIn !== chosen
						? `Turning this on moves computers from ${enabled.name} to ${builtIn.name}. Each project and bot gets a new one, without the old one's files.`
						: undefined
				}
			>
				<SettingsRow
					label={<span className="font-medium">Bots can use a computer</span>}
					sub={
						ready
							? "Each project and each bot gets its own private computer"
							: `${builtIn.name} needs an API key first. Add it below.`
					}
					trailing={
						<Toggle
							checked={enabled?.builtIn === chosen}
							disabled={!ready || pending}
							label="Bots can use a computer"
							onChange={(next) => void switchTo(next)}
						/>
					}
				/>
			</SettingsGroup>
			<SettingsRadioList
				legend="Provider"
				options={builtInComputerProviders.map((candidate) => ({
					...candidate,
					badge: candidate.id === enabled?.builtIn ? "In use" : undefined,
				}))}
				chosen={chosen}
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
			<ComputerNetworkSection
				modeRow={
					<SettingsRow
						label={
							<span className="font-medium">
								{(settings.networkMode ?? COMPUTER_NETWORK_MODE_DEFAULT) === "allowed-hosts-only"
									? "Allowed hosts only"
									: "Open"}
							</span>
						}
						sub={networkSummary(settings)}
						trailing={
							<SegmentedControl
								label="Network"
								options={networkModes}
								value={settings.networkMode ?? COMPUTER_NETWORK_MODE_DEFAULT}
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
			<ProjectDisks />
		</>
	);
}

/**
 * The bots with their computer switched on, each opening its own settings,
 * where that switch is. A bot can have one only while the workspace does, so
 * the list says so when there is none.
 */
function BotsUsingAComputer() {
	const { bots } = useBots();
	const using = (bots ?? []).filter((bot) => bot.usesComputer);
	if (!bots) return null;
	return (
		<SettingsGroup
			label="Bots using a computer"
			note="Switch a computer on or off in each bot's settings."
		>
			{using.length === 0 && (
				<SettingsRow label={<span className="text-muted-foreground">None yet</span>} />
			)}
			{using.map((bot) => (
				<SettingsRow
					key={bot.id}
					icon={<BotAvatar color={bot.color} eyes={bot.eyes} shape={bot.shape} size={24} />}
					label={bot.name}
					chevron
					render={<Link {...botSettingsLink(bot)} />}
				/>
			))}
		</SettingsGroup>
	);
}

/**
 * How full each project's computer's disk was when last measured, fullest
 * first, named by the project or, for a bot's default project, the bot, each
 * opening its Computer page, which shows what fills it. Hidden until one has
 * been measured.
 */
function ProjectDisks() {
	const { data: disks } = useComputerDisks();
	const { bots } = useBots();
	const { data: projects } = useProjects();
	const ownerByProject = new Map<string, ResourceOwner>([
		...(projects ?? []).map((project) => [project.id, { project }] as const),
		...(bots ?? []).map((bot) => [bot.defaultProjectId, { bot }] as const),
	]);
	const measured = (disks ?? [])
		.flatMap(({ projectId, disk }) => {
			const owner = ownerByProject.get(projectId);
			return owner ? [{ projectId, owner, disk }] : [];
		})
		.toSorted((a, b) => computerDiskShare(b.disk) - computerDiskShare(a.disk));
	if (measured.length === 0) return null;
	return (
		<SettingsGroup
			label="Disk use"
			note="Measured every few minutes while each computer is on. Once a computer's disk fills, its commands fail."
		>
			{measured.map(({ projectId, owner, disk }) => (
				<SettingsRow
					key={projectId}
					label={ownerName(owner)}
					sub={
						<>
							<DiskMeter disk={disk} label={`${ownerName(owner)} disk used`} />
							{diskSummary(disk)}
						</>
					}
					trailing={<DiskPercent disk={disk} />}
					chevron
					render={ownerLink(owner, { page: "computer" })}
				/>
			))}
		</SettingsGroup>
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
	chosen: BuiltInComputerProviderId;
	provider: ComputerProvider | undefined;
	pending: boolean;
	testResult: ProviderTestResult | undefined;
	onConfigure: (changes: ComputerProviderUpdate) => Promise<void>;
	/** Says why a typed value can't be saved. */
	onInvalid: (message: string) => void;
	onTest: () => void;
	onRemove: () => Promise<unknown>;
}) {
	const builtIn = computerBuiltInProvider(chosen);
	const settings: ComputerProviderSettings = provider?.settings ?? { builtIn: chosen };
	const [removingKey, setRemovingKey] = useState(false);
	const [removing, setRemoving] = useState(false);
	const [removeError, setRemoveError] = useState<string>();
	const hasKey = provider?.hasApiKey === true;

	return (
		<SettingsGroup label={builtIn.name} note={testStanding(provider, testResult) ?? hint(chosen)}>
			{settings.builtIn === "opensandbox" && (
				<TextEntryRow
					label="Server URL"
					saved={settings.serverUrl ?? builtIn.baseUrl}
					placeholder={builtIn.baseUrl ?? ""}
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
			{settings.builtIn === "opensandbox" && (
				<TextEntryRow
					label={builtIn.imageLabel}
					saved={settings.image}
					placeholder={builtIn.defaultImage}
					disabled={pending}
					clearable
					onSave={(image) => onConfigure({ settings: { ...settings, image: image || undefined } })}
				/>
			)}
			{settings.builtIn === "e2b" && (
				<>
					<TextEntryRow
						label={builtIn.imageLabel}
						saved={settings.template}
						placeholder={builtIn.defaultImage}
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
				placeholder={String(builtIn.defaultSize.cpuCount)}
				disabled={pending}
				clearable
				onSave={(typed) => {
					const cpuCount = wholeNumber(typed);
					if (typed && !Schema.is(computerCpuCountSchema)(cpuCount)) {
						onInvalid("Enter a whole number of vCPUs, from 1 to 64.");
						return Promise.resolve();
					}
					return onConfigure({ settings: { ...settings, cpuCount } });
				}}
			/>
			<TextEntryRow
				label="Memory"
				saved={settings.memoryGiB === undefined ? undefined : `${settings.memoryGiB} GiB`}
				placeholder={`${builtIn.defaultSize.memoryGiB} GiB`}
				disabled={pending}
				clearable
				onSave={(typed) => {
					const memoryGiB = wholeNumber(typed.replace(/\s*GiB$/i, ""));
					if (typed && !Schema.is(computerMemoryGiBSchema)(memoryGiB)) {
						onInvalid("Enter a whole number of GiB, from 1 to 64.");
						return Promise.resolve();
					}
					return onConfigure({ settings: { ...settings, memoryGiB } });
				}}
			/>
			{chosen === "e2b" && provider && hasKey && <TemplateRow providerId={provider.id} />}
			{provider && hasKey && (
				<SettingsRow
					label="Test provider"
					sub="Checks the provider answers and accepts the key."
					onClick={pending ? undefined : onTest}
				/>
			)}
			{provider && (
				<SettingsRow
					label={`Remove ${builtIn.name}`}
					sub="Removes its computers and settings."
					onClick={pending ? undefined : () => setRemoving(true)}
				/>
			)}
			<DeleteDialog
				open={removingKey}
				onOpenChange={setRemovingKey}
				title={`Remove the ${builtIn.name} key?`}
				description="Projects and bots stop getting computers from this provider until another key is added."
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
				title={`Remove ${builtIn.name}?`}
				description={
					removeError ??
					"Every computer at this provider is destroyed, with its files, including work that wasn't pushed."
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
	const template = useComputerTemplate(providerId);
	const prepare = usePrepareComputerTemplate(providerId);
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
							? "Ready. Rebuilding takes Sugabots' latest image, which computers move to when upgraded."
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
function networkSummary(settings: ComputerProviderSettings): string {
	if ((settings.networkMode ?? COMPUTER_NETWORK_MODE_DEFAULT) === "allowed-hosts-only") {
		return "Only the hosts allowed";
	}
	return settings.builtIn === "e2b"
		? "Any host. E2B can't block hosts"
		: "Any host but the blocked ones";
}

function hint(builtIn: BuiltInComputerProviderId): string {
	return builtIn === "opensandbox"
		? "The server's own API key, from its configuration. Leave the image empty to use the default. A new size takes effect when a computer is reset; on Kubernetes, one too big for any node never starts."
		: "Leave the URLs empty for E2B Cloud. For E2B Embed, give both. A new size takes effect once the template is prepared again and a computer is reset.";
}

/** A number typed into a row, or undefined when the row was emptied. */
function wholeNumber(typed: string): number | undefined {
	return typed === "" ? undefined : Number(typed);
}

/** What the last test said, once one has run, or what the provider recorded. */
function testStanding(
	provider: ComputerProvider | undefined,
	latest: ProviderTestResult | undefined,
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
