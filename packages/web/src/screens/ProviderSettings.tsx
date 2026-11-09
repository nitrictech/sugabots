import { type LivelyFace, LivelyGroup } from "@sugabots/avatars";
import {
	type Agent,
	effectiveCapabilities,
	type ModelProvider,
	type ProviderModel,
	type ProviderModelCapability,
	type ProviderPresetId,
	presetSignInService,
	presetSignsIn,
	providerLacksCredential,
	providerModelCapabilityCatalog,
	providerPreset,
	seededPresets,
} from "@sugabots/contracts";
import { ProviderLogo } from "@sugabots/provider-logos";
import { Link, linkOptions, useRouter } from "@tanstack/react-router";
import {
	Brain,
	Check,
	Eye,
	Grid2X2,
	Image,
	type LucideIcon,
	Mic,
	Pencil,
	RefreshCw,
	Search,
	Wrench,
} from "lucide-react";
import {
	type ComponentProps,
	type FormEvent,
	type ReactNode,
	useDeferredValue,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useAgents, useModels } from "@/lib/agents.ts";
import { useBuiltInAgents } from "@/lib/built-in-agents.ts";
import { failureMessage } from "@/lib/failure.ts";
import { MODEL_MAKER_NAMES } from "@/lib/model-makers.ts";
import { useModelProviders, useProviderActions } from "@/lib/model-providers.ts";
import { searchModels } from "@/lib/model-search.ts";
import { parseProviderBaseUrl } from "@/lib/provider-url.ts";
import { MODEL_SEARCH_THRESHOLD } from "@/lib/screen-limits.ts";
import { useBackTarget } from "@/lib/settings-back.tsx";
import { AgentAvatar, TurnTakingAvatar } from "@/shell/Agent.tsx";
import { Alert } from "@/ui/alert.tsx";
import { useLeave } from "@/ui/back-button.tsx";
import { Button } from "@/ui/button.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import { Dialog, DialogDescription } from "@/ui/dialog.tsx";
import {
	DialogForm,
	DialogFormBody,
	DialogFormFooter,
	DialogFormHeader,
} from "@/ui/dialog-form.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { SegmentedControl } from "@/ui/segmented-control.tsx";
import {
	PageBackLink,
	SettingsAddRow,
	SettingsDanger,
	SettingsGroup,
	SettingsPage,
	SettingsRow,
	SettingsRowIcon,
	SettingsTestOutcome,
} from "@/ui/settings-page.tsx";
import { Toggle } from "@/ui/toggle.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";
import { ConnectionRow, savedKeyMask, valueText } from "./connection-row.tsx";
import { ProviderSignInRow } from "./ProviderSignIn.tsx";

/*
 * One provider: how it is reached, which of its models bots may use, and
 * disconnecting it. A switched-off model is still listed, in its place, so
 * turning one on or off never moves the list under your pointer.
 */

/**
 * Whether bots can reach a provider: switched on, and holding the key or
 * sign-in it needs. Anthropic, OpenAI and Ollama exist in every workspace from the
 * start, so for them this, not existing, is what "added" means.
 */
export function isConnected(provider: ModelProvider): boolean {
	return provider.active && !providerLacksCredential(provider);
}

/**
 * A provider's tile: its official logo for a preset, and its first letter for
 * a custom provider, which has only a name.
 */
export function ProviderTile({
	name,
	preset,
	size = 28,
}: {
	name: string;
	preset: ProviderPresetId | null;
	size?: 28 | 44;
}) {
	const large = size === 44;
	return (
		<SettingsRowIcon className={large ? "size-11 rounded-xl border-0 bg-chip text-sm" : undefined}>
			{preset ? (
				<ProviderLogo preset={preset} className={large ? "size-5.5" : "size-3.5"} />
			) : (
				name.trim().charAt(0).toUpperCase()
			)}
		</SettingsRowIcon>
	);
}

/** The bots on a model, as overlapping faces with a count past the first few. */
export function BotFaces({ bots }: { bots: readonly Agent[] }) {
	if (bots.length === 0) return null;
	const shown = bots.slice(0, bots.length > 3 ? 2 : 3);
	const more = bots.length - shown.length;
	return (
		<span aria-hidden className="flex shrink-0 items-center">
			{shown.map((bot, index) => (
				<AgentAvatar
					key={bot.id}
					color={bot.color}
					face={bot.face}
					shape={bot.shape}
					size={22}
					ringed={{ color: "var(--settings-card)", width: 2 }}
					className={index > 0 ? "-ml-1.5" : undefined}
				/>
			))}
			{more > 0 && (
				<span className="-ml-1.5 grid h-5.5 min-w-5.5 place-items-center rounded-full bg-chip px-1 font-semibold text-2xs text-soft-foreground ring-2 ring-settings-card">
					+{more}
				</span>
			)}
		</span>
	);
}

/** The most faces that fit in one row of a dialog, on a phone too. */
const FACES_IN_A_ROW = 8;

/**
 * The bots in `bots` as one row of faces, each named on hover or keyboard
 * focus. Past a row, the last place counts the others and names them on hover.
 */
function NamedBotFaces({ bots, label }: { bots: readonly Agent[]; label: string }) {
	const faced = bots.length > FACES_IN_A_ROW ? bots.slice(0, FACES_IN_A_ROW - 1) : bots;
	const others = bots.slice(faced.length);
	return (
		<LivelyGroup>
			<ul
				aria-label={label}
				// Room around each face for its focus ring and its hop.
				className="-m-1.5 flex list-none items-center justify-center gap-1.5 p-1.5"
			>
				{faced.map((bot) => (
					<li key={bot.id} className="flex">
						<NamedBotFace bot={bot} />
					</li>
				))}
				{others.length > 0 && (
					<li className="ml-1 text-muted-foreground text-xs">
						and <OtherBots bots={others} />
					</li>
				)}
			</ul>
		</LivelyGroup>
	);
}

/** "N others", naming them on hover or keyboard focus. */
function OtherBots({ bots }: { bots: readonly Agent[] }) {
	return (
		<Tooltip
			label={<OtherBotsList bots={bots} />}
			side="top"
			onOpenChange={nameOnKeyboardFocusOnly}
		>
			<span
				// biome-ignore lint/a11y/noNoninteractiveTabindex: its names show only on hover or focus, so it must be reachable from the keyboard.
				tabIndex={0}
				className="focus-ring cursor-default rounded-sm text-foreground underline decoration-dotted underline-offset-2"
			>
				{bots.length} {bots.length === 1 ? "other" : "others"}
				<span className="sr-only">: {LIST.format(bots.map((bot) => bot.name))}</span>
			</span>
		</Tooltip>
	);
}

const LIST = new Intl.ListFormat("en", { type: "conjunction" });

/**
 * Each bot by its face and name. Past about a dozen it scrolls, fading out at
 * the bottom while there are more below, as the scrollbar shows only while
 * scrolling.
 */
function OtherBotsList({ bots }: { bots: readonly Agent[] }) {
	const list = useRef<HTMLUListElement>(null);
	const [moreBelow, setMoreBelow] = useState(false);
	const checkMoreBelow = () => {
		const element = list.current;
		if (!element) return;
		// A pixel of slack, as zoomed pages scroll in fractions of one.
		setMoreBelow(element.scrollTop + element.clientHeight < element.scrollHeight - 1);
	};
	useLayoutEffect(checkMoreBelow, []);
	return (
		<ul
			ref={list}
			aria-label="Other bots"
			// It takes focus so the keyboard can scroll it.
			// biome-ignore lint/a11y/noNoninteractiveTabindex: a list that scrolls must be reachable to scroll it.
			tabIndex={0}
			onScroll={checkMoreBelow}
			className={`focus-ring -mx-1 flex max-h-64 list-none flex-col gap-1 overflow-y-auto rounded-sm px-1 py-0.5 ${moreBelow ? "mask-b-from-75%" : ""}`}
		>
			{bots.map((bot) => (
				<li key={bot.id} className="flex items-center gap-1.5">
					<AgentAvatar color={bot.color} face={bot.face} shape={bot.shape} size={16} />
					<span className="truncate">{bot.name}</span>
				</li>
			))}
		</ul>
	);
}

/** A dialog opened by pointer focuses its first trigger; only keyboard focus should open its tooltip. */
function nameOnKeyboardFocusOnly(
	open: boolean,
	details: Parameters<NonNullable<ComponentProps<typeof Tooltip>["onOpenChange"]>>[1],
) {
	if (
		open &&
		details.reason === "trigger-focus" &&
		!(details.event.target as Element).matches(":focus-visible")
	) {
		details.cancel();
	}
}

/** One bot's face, which hops as the pointer or keyboard comes onto it and names the bot. */
function NamedBotFace({ bot }: { bot: Agent }) {
	const face = useRef<LivelyFace>(null);
	return (
		<Tooltip label={bot.name} side="top" onOpenChange={nameOnKeyboardFocusOnly}>
			<span
				role="img"
				aria-label={bot.name}
				// biome-ignore lint/a11y/noNoninteractiveTabindex: its name shows only on hover or focus, so it must be reachable from the keyboard.
				tabIndex={0}
				className="focus-ring flex rounded-full"
				onPointerEnter={() => face.current?.play("hop")}
				onFocus={(event) =>
					event.currentTarget.matches(":focus-visible") && face.current?.play("hop")
				}
			>
				<TurnTakingAvatar bot={bot} size={28} faceRef={face} />
			</span>
		</Tooltip>
	);
}

/** The crew bots on each model id, which is what a bot's `model` names. */
export function useBotsByModel(): (modelId: string) => Agent[] {
	const { agents } = useAgents();
	return (modelId) =>
		agents?.filter((agent) => agent.systemAgentKey === null && agent.model === modelId) ?? [];
}

/**
 * What must keep running on each model id: new bots, which start on the
 * workspace's default, and the system bots. The server refuses to switch such
 * a model off, or its provider, until they are moved to another, so the page
 * says so before anybody tries.
 */
export function useModelHolders(): (modelId: string) => ModelHolders | undefined {
	const defaultModel = useModels().data?.defaultModel ?? null;
	const systemAgents = useBuiltInAgents().data ?? [];
	return (modelId) => {
		const newBots = modelId === defaultModel;
		const systemBots = systemAgents.some((agent) => agent.model === modelId);
		return newBots || systemBots ? { newBots, systemBots } : undefined;
	};
}

export interface ModelHolders {
	newBots: boolean;
	systemBots: boolean;
}

/** Why a model, or its provider, cannot be switched off. */
export function heldReason({ newBots, systemBots }: ModelHolders, subject: string): string {
	const holders =
		newBots && systemBots
			? "New bots and system agents use"
			: newBots
				? "New bots use"
				: "System agents use";
	return `${holders} ${subject}. Choose another model for them under Models → Default first.`;
}

export function modelName(model: Pick<ProviderModel, "displayName" | "modelId">): string {
	return model.displayName ?? model.modelId;
}

export function ProviderSettings({ providerId }: { providerId: string }) {
	const providers = useModelProviders();
	if (providers.isPending) return null;
	const provider = providers.data?.find((one) => one.id === providerId);
	if (!provider) {
		return (
			<div className="grid min-h-80 place-items-center p-6">
				<EmptyState title={providers.error ? "Could not load this provider" : "No such provider"}>
					{providers.error
						? failureMessage(providers.error)
						: "It may have been disconnected. Its models are no longer offered."}
				</EmptyState>
			</div>
		);
	}
	return <ProviderPage key={provider.id} provider={provider} />;
}

function ProviderPage({ provider }: { provider: ModelProvider }) {
	const actions = useProviderActions();
	const router = useRouter();
	const { leaveForPage } = useLeave();
	const [disconnecting, setDisconnecting] = useState(false);
	const preset = provider.preset === null ? null : providerPreset(provider.preset);
	// The ones every workspace starts with cannot be deleted, so disconnecting
	// one takes its key or sign-in away and switches it off, and adding it again brings it back.
	const seeded = provider.preset !== null && seededPresets.includes(provider.preset);
	const signsIn = presetSignsIn(provider.preset);
	const disconnect = seeded ? actions.update : actions.remove;
	const disconnectPending = disconnect.isPending || actions.signOut.isPending;
	const disconnectError = disconnect.error ?? actions.signOut.error;
	// Switching a provider off only stops what it offers; removing one deletes
	// every model it lists, including one held while the provider is off.
	const held = useHoldersOf(seeded ? offeredModelsOf(provider) : provider.models);
	const heldOn = useHoldersOf(offeredModelsOf(provider));
	const cannotTurnOff = provider.active && heldOn !== undefined;

	async function confirmDisconnect() {
		try {
			if (seeded) {
				if (provider.signedIn) {
					await actions.signOut.mutateAsync({ providerId: provider.id });
				}
				await actions.update.mutateAsync({
					providerId: provider.id,
					json: { active: false, ...(provider.hasApiKey ? { apiKey: null } : {}) },
				});
			} else {
				await actions.remove.mutateAsync({ providerId: provider.id });
			}
		} catch {
			return;
		}
		setDisconnecting(false);
		// Back to Models, or Models in the provider's place, so Back never returns to one
		// no longer connected.
		leaveForPage(
			router.buildLocation(
				linkOptions({
					from: "/$workspace",
					to: "./settings/$section",
					params: { section: "providers" },
				}),
			).href,
		);
	}

	return (
		<SettingsPage
			back={<BackToModels />}
			backOnWide
			hero={<ProviderTile name={provider.name} preset={provider.preset} size={44} />}
			title={provider.name}
		>
			<SettingsGroup
				note={
					cannotTurnOff
						? `${provider.name} can't be turned off while it's in use. ${heldReason(heldOn, "one of its models")}`
						: actions.update.error
							? failureMessage(actions.update.error)
							: provider.active
								? "Bots can use the models you switch on below."
								: "Bots can't use its models while it's off."
				}
			>
				<SettingsRow
					label={provider.active ? "On" : "Off"}
					trailing={
						<Toggle
							checked={provider.active}
							disabled={cannotTurnOff || actions.update.isPending}
							label={`Use ${provider.name}`}
							onChange={(active) =>
								actions.update.mutate({ providerId: provider.id, json: { active } })
							}
						/>
					}
				/>
			</SettingsGroup>
			<Connection provider={provider} local={preset?.hosting === "local"} />
			<Models provider={provider} />
			<SettingsDanger
				label={`Disconnect ${provider.name}`}
				description="Bots using these models stop working until you pick another."
				action="Disconnect"
				onClick={() => setDisconnecting(true)}
				disabledReason={held && heldReason(held, "one of its models")}
			/>
			<DeleteDialog
				open={disconnecting}
				onOpenChange={setDisconnecting}
				title={`Disconnect ${provider.name}?`}
				description={
					seeded
						? `${signsIn ? "It is signed out" : "Its key is removed"} and bots can no longer use its models. You can connect it again at any time.`
						: "Bots can no longer use its models. Adding it again means entering its details again."
				}
				confirmLabel="Disconnect"
				pending={disconnectPending}
				error={disconnectError ? failureMessage(disconnectError) : undefined}
				onDelete={confirmDisconnect}
			/>
		</SettingsPage>
	);
}

export function BackToModels() {
	return (
		<PageBackLink
			{...useBackTarget({
				label: "Models",
				render: (
					<Link from="/$workspace" to="./settings/$section" params={{ section: "providers" }} />
				),
			})}
		/>
	);
}

/**
 * How the provider is reached. A hosted one is its key, or for a
 * subscription a sign-in; one you run is its address and an optional key; a custom one also
 * says which API it speaks.
 */
function Connection({ provider, local }: { provider: ModelProvider; local: boolean }) {
	const actions = useProviderActions();
	const custom = provider.preset === null;
	const signInService = presetSignInService(provider.preset);
	const error = actions.update.error ?? actions.test.error;
	const tested = actions.test.data;
	const held = useHoldersOf(offeredModelsOf(provider));

	return (
		<SettingsGroup
			label="Connection"
			note={
				// The result sits beside the button, so a test never moves what is below it.
				<span className="flex items-center gap-2.5">
					<Button
						variant="secondary"
						size="sm"
						disabled={actions.test.isPending}
						onClick={() => actions.test.mutate({ providerId: provider.id })}
					>
						{actions.test.isPending && <RefreshCw className="animate-spin" />}
						Test connection
					</Button>
					{!actions.test.isPending && (
						<TestOutcome
							reachable={tested ? tested.reachable : provider.lastTestError ? false : undefined}
							error={tested ? tested.error : provider.lastTestError}
						/>
					)}
				</span>
			}
		>
			{(local || custom) && (
				<EditableRow
					label="Server URL"
					value={provider.baseUrl}
					placeholder={local ? "http://localhost:11434" : "https://llm.example.com/v1"}
					pending={actions.update.isPending}
					problemWith={(typed) =>
						parseProviderBaseUrl(typed)
							? undefined
							: "That is not a server address. A host and port, like 192.168.1.10:11434, is enough."
					}
					onSave={async (typed) => {
						await actions.update.mutateAsync({
							providerId: provider.id,
							json: { baseUrl: parseProviderBaseUrl(typed) },
						});
					}}
				/>
			)}
			{custom && (
				<ConnectionRow
					label="Format"
					action={
						<SegmentedControl
							label="API format"
							options={API_FORMATS}
							value={provider.apiFormat}
							onChange={(apiFormat) =>
								actions.update.mutate({ providerId: provider.id, json: { apiFormat } })
							}
						/>
					}
				>
					{null}
				</ConnectionRow>
			)}
			{signInService ? (
				<ProviderSignInRow
					provider={provider}
					service={signInService}
					signOutBlocked={held && heldReason(held, "one of its models")}
				/>
			) : (
				<KeyRow provider={provider} optional={local || custom} />
			)}
			{error && (
				<div className="border-border border-t px-4 py-3">
					<Alert>{failureMessage(error)}</Alert>
				</div>
			)}
		</SettingsGroup>
	);
}

/**
 * How the last test went, as a dot and a few words beside Test connection:
 * green for working, red with the reason for not. A reason too long for the
 * line is cut short, and given whole when pointed at.
 */
function TestOutcome({
	reachable,
	error,
}: {
	/** Undefined while there is nothing to say: no test run, and no failure on record. */
	reachable: boolean | undefined;
	error: string | null | undefined;
}) {
	if (reachable === undefined) return null;
	return (
		<SettingsTestOutcome good={reachable}>
			{reachable ? "Connection successful" : (error ?? "It did not answer.")}
		</SettingsTestOutcome>
	);
}

/** The two APIs a custom provider can speak. */
export const API_FORMATS = [
	{ value: "openai", label: "OpenAI" },
	{ value: "anthropic", label: "Anthropic" },
] as const;

const fieldText =
	"w-full min-w-0 bg-transparent font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground";

function EditableRow({
	label,
	value,
	placeholder,
	pending,
	problemWith,
	onSave,
}: {
	label: string;
	value: string;
	placeholder: string;
	pending: boolean;
	/** What is wrong with what was typed, checked before it is sent. */
	problemWith: (typed: string) => string | undefined;
	onSave: (typed: string) => Promise<void>;
}) {
	const [draft, setDraft] = useState<string>();
	const [problem, setProblem] = useState<string>();
	const id = useId();

	async function save(event: FormEvent) {
		event.preventDefault();
		if (draft === undefined) return;
		const wrong = problemWith(draft);
		setProblem(wrong);
		if (wrong) return;
		try {
			await onSave(draft);
		} catch {
			// The group says what the server refused; the field stays as typed.
			return;
		}
		setDraft(undefined);
	}

	if (draft === undefined) {
		return (
			<ConnectionRow
				label={label}
				action={
					<Button variant="link" size="bare" className="text-xs" onClick={() => setDraft(value)}>
						Change
					</Button>
				}
			>
				<span className={valueText}>{value}</span>
			</ConnectionRow>
		);
	}
	return (
		<form onSubmit={save}>
			<ConnectionRow
				label={label}
				action={
					<span className="flex shrink-0 items-center gap-3">
						<Button variant="link" size="bare" className="text-xs" type="submit" disabled={pending}>
							Save
						</Button>
						<Button
							variant="ghost"
							size="bare"
							className="text-xs"
							type="button"
							onClick={() => setDraft(undefined)}
						>
							Cancel
						</Button>
					</span>
				}
			>
				<label htmlFor={id} className="sr-only">
					{label}
				</label>
				<input
					id={id}
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					placeholder={placeholder}
					className={fieldText}
				/>
				{problem && <span className="block pt-1 text-destructive-text text-xs">{problem}</span>}
			</ConnectionRow>
		</form>
	);
}

/**
 * What must keep running on any of `models`, all of them together, or nothing
 * when none is held.
 */
function useHoldersOf(models: readonly ProviderModel[]): ModelHolders | undefined {
	const holdersOf = useModelHolders();
	const held = models.flatMap((model) => holdersOf(model.modelId) ?? []);
	if (held.length === 0) return undefined;
	return {
		newBots: held.some((holders) => holders.newBots),
		systemBots: held.some((holders) => holders.systemBots),
	};
}

/** The models the provider offers agents: none while it is not connected. */
function offeredModelsOf(provider: ModelProvider): ProviderModel[] {
	return isConnected(provider) ? provider.models.filter((model) => model.enabled) : [];
}

/** The key, masked once saved; Replace swaps it for a new one. */
function KeyRow({ provider, optional }: { provider: ModelProvider; optional: boolean }) {
	const actions = useProviderActions();
	const held = useHoldersOf(offeredModelsOf(provider));
	const [replacing, setReplacing] = useState(!provider.hasApiKey && !optional);
	const [apiKey, setApiKey] = useState("");
	const id = useId();

	async function save(event: FormEvent) {
		event.preventDefault();
		if (!apiKey) return;
		try {
			await actions.update.mutateAsync({
				providerId: provider.id,
				// A key is what connects a provider that was disconnected.
				json: { apiKey, ...(provider.active ? {} : { active: true }) },
			});
		} catch {
			return;
		}
		setApiKey("");
		setReplacing(false);
	}

	if (!replacing) {
		return (
			<ConnectionRow
				label="API key"
				action={
					<span className="flex shrink-0 items-center gap-3">
						{optional && provider.hasApiKey && (
							<Button
								variant="ghost"
								size="bare"
								className="text-xs"
								disabled={actions.update.isPending || held !== undefined}
								title={held && heldReason(held, "one of its models")}
								onClick={() =>
									actions.update.mutate({ providerId: provider.id, json: { apiKey: null } })
								}
							>
								Remove
							</Button>
						)}
						<Button
							variant="link"
							size="bare"
							className="text-xs"
							onClick={() => setReplacing(true)}
						>
							{provider.hasApiKey ? "Replace" : "Add"}
						</Button>
					</span>
				}
			>
				<span className={valueText}>{provider.hasApiKey ? savedKeyMask : "None"}</span>
			</ConnectionRow>
		);
	}
	return (
		<form onSubmit={save}>
			<ConnectionRow
				label="API key"
				action={
					<span className="flex shrink-0 items-center gap-3">
						<Button
							variant="link"
							size="bare"
							className="text-xs"
							type="submit"
							disabled={!apiKey || actions.update.isPending}
						>
							Save
						</Button>
						{(provider.hasApiKey || optional) && (
							<Button
								variant="ghost"
								size="bare"
								className="text-xs"
								type="button"
								onClick={() => {
									setApiKey("");
									setReplacing(false);
								}}
							>
								Cancel
							</Button>
						)}
					</span>
				}
			>
				<label htmlFor={id} className="sr-only">
					{provider.name} API key
				</label>
				<input
					id={id}
					type="password"
					autoComplete="off"
					value={apiKey}
					onChange={(event) => setApiKey(event.target.value)}
					placeholder="Paste your key"
					className={fieldText}
				/>
				{actions.update.error && (
					<span role="alert" className="block pt-1 text-destructive-text text-xs">
						{failureMessage(actions.update.error)}
					</span>
				)}
			</ConnectionRow>
		</form>
	);
}

const capabilityIcons: Record<ProviderModelCapability, LucideIcon> = {
	tools: Wrench,
	vision: Eye,
	images: Image,
	audio: Mic,
	reasoning: Brain,
	embeddings: Grid2X2,
};

/** What a model can do, as small icons after its line; a capability switched off is left out. */
function CapabilityIcons({ model }: { model: ProviderModel }) {
	const on = effectiveCapabilities(model);
	return (
		<>
			{providerModelCapabilityCatalog
				.filter((entry) => on.includes(entry.key))
				.map((entry) => {
					const Icon = capabilityIcons[entry.key];
					return (
						<Icon
							key={entry.key}
							role="img"
							aria-label={entry.name}
							className="size-3.25 shrink-0"
							strokeWidth={2}
						/>
					);
				})}
		</>
	);
}

/**
 * A catalogue of hundreds scrolls inside its group, so the search above it
 * stays in reach. Its height is fixed and its scrollbar's room kept, so
 * narrowing the list by searching moves nothing around it.
 */
function ScrollingWhen({ large, children }: { large: boolean; children: ReactNode }) {
	if (!large) return children;
	return (
		<section
			aria-label="Model list"
			// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable from the keyboard.
			tabIndex={0}
			className="focus-ring relative h-tool-list overflow-y-auto border-border border-b scrollbar-gutter-stable last:border-b-0"
		>
			{children}
		</section>
	);
}

/** A box to search a list of `count` models, for one too long to scan. */
function ModelSearch({
	value,
	onChange,
	count,
}: {
	value: string;
	onChange: (value: string) => void;
	count: number;
}) {
	return (
		<label className="focus-ring-within flex h-8.5 items-center gap-2 rounded-lg border border-border-strong bg-background px-2.5">
			<Search aria-hidden size={14} className="shrink-0 text-subtle-foreground" />
			<input
				type="search"
				value={value}
				onChange={(event) => onChange(event.target.value)}
				placeholder={`Search ${count} models`}
				aria-label="Search models"
				className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-subtle-foreground"
			/>
		</label>
	);
}

/** Who makes a model on a provider that resells many: OpenRouter names it `maker/model`. */
function makerOf(model: ProviderModel): string | undefined {
	const slash = model.modelId.indexOf("/");
	return slash > 0 ? model.modelId.slice(0, slash) : undefined;
}

function makerLabel(maker: string): string {
	return MODEL_MAKER_NAMES[maker] ?? maker.charAt(0).toUpperCase() + maker.slice(1);
}

function Models({ provider }: { provider: ModelProvider }) {
	const actions = useProviderActions();
	const botsOn = useBotsByModel();
	const agents = useAgents();
	const offered = useModels();
	// Until both are known, switching a model off could leave bots on it unasked.
	const usageKnown = agents.agents !== undefined && offered.data !== undefined;
	const holdersOf = useModelHolders();
	const [search, setSearch] = useState("");
	const [adding, setAdding] = useState(false);
	const [checkingUsage, setCheckingUsage] = useState(false);
	const [movingBotsOff, setMovingBotsOff] = useState<ProviderModel>();
	const needle = useDeferredValue(search.trim().toLowerCase());
	const large = provider.models.length > MODEL_SEARCH_THRESHOLD;
	// Switched-on models lead, as they were when the page opened, so a row never moves under the toggle just used.
	const [onWhenOpened] = useState(
		() => new Set(provider.models.filter((model) => model.enabled).map((model) => model.id)),
	);
	const shown = searchModels(provider.models, needle).sort(
		(a, b) => Number(onWhenOpened.has(b.id)) - Number(onWhenOpened.has(a.id)),
	);
	const error = actions.setModel.error ?? actions.fetchModels.error;
	const custom = provider.preset === null;

	/**
	 * Switches the model off, or asks where its bots go when that would leave
	 * them on a model no provider offers. Decided on fresh bots and models, as
	 * the cached ones may predate another tab's changes.
	 */
	async function switchOff(model: ProviderModel) {
		setCheckingUsage(true);
		const [latestAgents, latestOffered] = await Promise.all([
			agents.refetch(),
			offered.refetch(),
		]).finally(() => setCheckingUsage(false));
		const strandsBots =
			(latestAgents.data ?? []).some(
				(agent) => agent.systemAgentKey === null && agent.model === model.modelId,
			) &&
			!(latestOffered.data?.models ?? []).some(
				(candidate) => candidate.modelId === model.modelId && candidate.providerId !== provider.id,
			);
		if (strandsBots) {
			setMovingBotsOff(model);
			return;
		}
		actions.setModel.mutate({ providerId: provider.id, modelId: model.id, enabled: false });
	}

	return (
		<SettingsGroup
			label="Models"
			action={
				<Button
					variant="link"
					size="bare"
					className="text-xs"
					disabled={actions.fetchModels.isPending || providerLacksCredential(provider)}
					onClick={() => actions.fetchModels.mutate({ providerId: provider.id })}
				>
					{actions.fetchModels.isPending ? "Refreshing…" : "Refresh list"}
				</Button>
			}
			note="Only switched-on models show up when choosing a bot's model."
		>
			{large && (
				<div className="border-border border-b p-2.5">
					<ModelSearch value={search} onChange={setSearch} count={provider.models.length} />
				</div>
			)}
			<ScrollingWhen large={large}>
				{shown.length === 0 && (
					<SettingsRow
						label={
							needle ? "No models match." : "No models yet. Refresh the list once it is connected."
						}
					/>
				)}
				{shown.map((model) => {
					const bots = botsOn(model.modelId);
					const used =
						bots.length === 0
							? "Not used yet"
							: `${bots.length} ${bots.length === 1 ? "bot" : "bots"}`;
					const who = large ? makerLabel(makerOf(model) ?? provider.name) : used;
					const held = model.enabled ? holdersOf(model.modelId) : undefined;
					return (
						<SettingsRow
							key={model.id}
							label={modelName(model)}
							sub={
								<span className="flex items-center gap-1.5">
									{held ? `${held.newBots ? "Default" : "Summaries"} · ${who}` : who}
									<CapabilityIcons model={model} />
								</span>
							}
							trailing={
								<>
									<BotFaces bots={bots} />
									{custom && <EditCapabilities provider={provider} model={model} />}
									<Toggle
										checked={model.enabled}
										disabled={
											!provider.active ||
											actions.setModel.isPending ||
											checkingUsage ||
											held !== undefined ||
											(model.enabled && !usageKnown)
										}
										tooltip={held && heldReason(held, "this model")}
										label={`Bots can use ${modelName(model)}`}
										onChange={(enabled) =>
											enabled
												? actions.setModel.mutate({
														providerId: provider.id,
														modelId: model.id,
														enabled,
													})
												: switchOff(model)
										}
									/>
								</>
							}
						/>
					);
				})}
			</ScrollingWhen>
			<Dialog
				open={movingBotsOff !== undefined}
				onOpenChange={(open) => !open && setMovingBotsOff(undefined)}
			>
				{movingBotsOff && (
					<MoveBotsDialog
						provider={provider}
						model={movingBotsOff}
						bots={botsOn(movingBotsOff.modelId)}
						done={() => setMovingBotsOff(undefined)}
					/>
				)}
			</Dialog>
			{custom &&
				(adding ? (
					<AddModelRow provider={provider} done={() => setAdding(false)} />
				) : (
					<SettingsAddRow label="Add model" onClick={() => setAdding(true)} />
				))}
			{error && (
				<div className="border-border border-t px-4 py-3">
					<Alert>{failureMessage(error)}</Alert>
				</div>
			)}
		</SettingsGroup>
	);
}

/**
 * Switching off a model bots still run on: which of the other switched-on
 * models they move to, starting on the one new bots use. They move and the
 * model goes off together, so no bot is left on a model that is off.
 */
function MoveBotsDialog({
	provider,
	model,
	bots,
	done,
}: {
	provider: ModelProvider;
	model: ProviderModel;
	bots: readonly Agent[];
	done: () => void;
}) {
	const actions = useProviderActions();
	const models = useModels().data;
	const candidates = (models?.models ?? []).filter(
		(candidate) => candidate.modelId !== model.modelId,
	);
	const [search, setSearch] = useState("");
	const needle = useDeferredValue(search.trim().toLowerCase());
	const [picked, setPicked] = useState<string>();
	const offeredHere = (modelId: string | null | undefined) =>
		candidates.some((candidate) => candidate.modelId === modelId);
	// Follows the models as they load or change, until someone picks one.
	const chosen = offeredHere(picked)
		? picked
		: offeredHere(models?.defaultModel)
			? models?.defaultModel
			: candidates[0]?.modelId;
	const shown = searchModels(candidates, needle);
	const providerNames = [...new Set(shown.map((candidate) => candidate.providerName))];
	const name = modelName(model);

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!chosen) return;
		try {
			await actions.switchOffModel.mutateAsync({
				providerId: provider.id,
				modelId: model.id,
				moveBotsTo: chosen,
			});
		} catch {
			return;
		}
		done();
	}

	return (
		<DialogForm width="compact" onSubmit={submit}>
			<DialogFormHeader title={`Switch off ${name}`} />
			<DialogFormBody>
				<DialogDescription>
					{bots.length === 1 ? "This bot uses" : "These bots use"} {name}. Choose the model to move{" "}
					{bots.length === 1 ? "it" : "them"} to.
				</DialogDescription>
				<NamedBotFaces bots={bots} label={`Bots on ${name}`} />
				{candidates.length === 0 ? (
					<Alert>
						{name} is the only model switched on. Switch on another first, so the bots have one to
						move to.
					</Alert>
				) : (
					<>
						{candidates.length > MODEL_SEARCH_THRESHOLD && (
							<ModelSearch value={search} onChange={setSearch} count={candidates.length} />
						)}
						<div className="-mx-1 flex max-h-picker-tall flex-col gap-5 overflow-y-auto px-1 max-md:max-h-none max-md:overflow-visible">
							{shown.length === 0 && (
								<SettingsGroup>
									<SettingsRow label="No models match." />
								</SettingsGroup>
							)}
							{providerNames.map((providerName) => (
								<SettingsGroup key={providerName} label={providerName}>
									{shown
										.filter((candidate) => candidate.providerName === providerName)
										.map((candidate) => {
											const selected = candidate.modelId === chosen;
											return (
												<SettingsRow
													key={candidate.modelId}
													label={candidate.displayName ?? candidate.modelId}
													render={<button type="button" aria-pressed={selected} />}
													trailing={
														selected && (
															<Check
																aria-hidden
																size={16}
																strokeWidth={2.6}
																className="shrink-0 text-link"
															/>
														)
													}
													onClick={() => setPicked(candidate.modelId)}
												/>
											);
										})}
								</SettingsGroup>
							))}
						</div>
					</>
				)}
				{actions.switchOffModel.error && (
					<Alert>{failureMessage(actions.switchOffModel.error)}</Alert>
				)}
			</DialogFormBody>
			<DialogFormFooter
				action={bots.length === 1 ? "Move bot and switch off" : "Move bots and switch off"}
				actionDisabled={!chosen || actions.switchOffModel.isPending}
				onCancel={done}
			/>
		</DialogForm>
	);
}

/** A model a custom server has but does not list, added by its id. */
function AddModelRow({ provider, done }: { provider: ModelProvider; done: () => void }) {
	const actions = useProviderActions();
	const [modelId, setModelId] = useState("");
	const id = useId();
	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				if (!modelId.trim()) return;
				actions.addModel.mutate(
					{ providerId: provider.id, modelId: modelId.trim() },
					{ onSuccess: done },
				);
			}}
		>
			<ConnectionRow
				label="Model ID"
				action={
					<span className="flex shrink-0 items-center gap-3">
						<Button
							variant="link"
							size="bare"
							className="text-xs"
							type="submit"
							disabled={!modelId.trim() || actions.addModel.isPending}
						>
							Add
						</Button>
						<Button variant="ghost" size="bare" className="text-xs" type="button" onClick={done}>
							Cancel
						</Button>
					</span>
				}
			>
				<label htmlFor={id} className="sr-only">
					Model ID
				</label>
				<input
					id={id}
					value={modelId}
					onChange={(event) => setModelId(event.target.value)}
					placeholder="e.g. llama-3.3-70b"
					className={fieldText}
				/>
				{actions.addModel.error && (
					<span role="alert" className="block pt-1 text-destructive-text text-xs">
						{failureMessage(actions.addModel.error)}
					</span>
				)}
			</ConnectionRow>
		</form>
	);
}

/**
 * A custom server says nothing about what its models can do, so what they can
 * is set by hand here: tools, images and the rest.
 */
function EditCapabilities({ provider, model }: { provider: ModelProvider; model: ProviderModel }) {
	const [open, setOpen] = useState(false);
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<IconButton label={`What ${modelName(model)} can do`} onClick={() => setOpen(true)}>
				<Pencil />
			</IconButton>
			{open && <CapabilitiesDialog provider={provider} model={model} done={() => setOpen(false)} />}
		</Dialog>
	);
}

function CapabilitiesDialog({
	provider,
	model,
	done,
}: {
	provider: ModelProvider;
	model: ProviderModel;
	done: () => void;
}) {
	const actions = useProviderActions();
	const [chosen, setChosen] = useState<ProviderModelCapability[]>(effectiveCapabilities(model));
	// A model added by hand has whatever you say. One the server listed has what
	// it said, and each of those can only be switched off.
	const byHand = model.source === "manual";
	const offered = byHand
		? providerModelCapabilityCatalog
		: providerModelCapabilityCatalog.filter((entry) => model.capabilities.includes(entry.key));

	async function submit(event: FormEvent) {
		event.preventDefault();
		try {
			await actions.updateModel.mutateAsync({
				providerId: provider.id,
				modelId: model.id,
				json: byHand
					? { capabilities: chosen }
					: {
							disabledCapabilities: model.capabilities.filter(
								(capability) => !chosen.includes(capability),
							),
						},
			});
		} catch {
			return;
		}
		done();
	}

	return (
		<DialogForm width="compact" onSubmit={submit}>
			<DialogFormHeader title="What it can do" />
			<DialogFormBody>
				<DialogDescription className="font-mono">{model.modelId}</DialogDescription>
				{offered.length === 0 ? (
					<p className="m-0 text-xs text-muted-foreground">
						The server lists nothing this model can do, so there is nothing to switch.
					</p>
				) : (
					<SettingsGroup>
						{offered.map((entry) => {
							const Icon = capabilityIcons[entry.key];
							const on = chosen.includes(entry.key);
							return (
								<SettingsRow
									key={entry.key}
									icon={<Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />}
									label={entry.name}
									sub={entry.description}
									trailing={
										<Toggle
											checked={on}
											label={entry.name}
											onChange={(next) =>
												setChosen(
													next
														? [...chosen, entry.key]
														: chosen.filter((capability) => capability !== entry.key),
												)
											}
										/>
									}
								/>
							);
						})}
					</SettingsGroup>
				)}
				{actions.updateModel.error && <Alert>{failureMessage(actions.updateModel.error)}</Alert>}
			</DialogFormBody>
			<DialogFormFooter
				action="Save"
				actionDisabled={actions.updateModel.isPending}
				onCancel={done}
			/>
		</DialogForm>
	);
}
