import { type LivelyFace, LivelyGroup } from "@sugabots/avatars";
import {
	type Bot,
	type BuiltInProviderId,
	builtInSignInService,
	builtInSignsIn,
	effectiveCapabilities,
	type ModelProvider,
	type ProviderModel,
	type ProviderModelCapability,
	type ProviderSwitchOff,
	providerBuiltIn,
	providerIsUsable,
	providerLacksCredential,
	providerModelCapabilityCatalog,
	seededBuiltIns,
	type WorkspaceModelsResponse,
} from "@sugabots/contracts";
import { ProviderLogo } from "@sugabots/provider-logos";
import { Link, useRouter } from "@tanstack/react-router";
import { cn } from "cn";
import {
	Brain,
	ChevronDown,
	Eye,
	Grid2X2,
	Image,
	type LucideIcon,
	Mic,
	Pencil,
	RefreshCw,
	Wrench,
} from "lucide-react";
import {
	type ComponentProps,
	type FormEvent,
	type ReactNode,
	useDeferredValue,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useBots, useModels } from "@/lib/bots.ts";
import { failureMessage } from "@/lib/failure.ts";
import { settingsSectionLink } from "@/lib/links.ts";
import { formatTimeAfterVerb } from "@/lib/list-time.ts";
import { MODEL_MAKER_NAMES } from "@/lib/model-makers.ts";
import { modelName, useModelProviders, useProviderActions } from "@/lib/model-providers.ts";
import { searchModels } from "@/lib/model-search.ts";
import { capitalise, countOf } from "@/lib/name-list.ts";
import { NOT_A_SERVER_ADDRESS, parseProviderBaseUrl } from "@/lib/provider-url.ts";
import { MODEL_SEARCH_THRESHOLD } from "@/lib/screen-limits.ts";
import { useSystemBots } from "@/lib/system-bots.ts";
import { BotAvatar, TurnTakingAvatar } from "@/shell/Bot.tsx";
import { Alert } from "@/ui/alert.tsx";
import { useBackToLinkedPage, useLeave } from "@/ui/back-button.tsx";
import { Button } from "@/ui/button.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import { Dialog, DialogDescription } from "@/ui/dialog.tsx";
import {
	DialogForm,
	DialogFormBody,
	DialogFormFooter,
	DialogFormHeader,
	DialogFormScroll,
} from "@/ui/dialog-form.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { LetterTile } from "@/ui/letter-tile.tsx";
import { SearchField } from "@/ui/search-field.tsx";
import { SegmentedControl } from "@/ui/segmented-control.tsx";
import {
	PageBackLink,
	SettingsAddRow,
	SettingsDanger,
	SettingsGroup,
	SettingsPage,
	SettingsRow,
	SettingsRowAlert,
	SettingsRowIcon,
	SettingsTestOutcome,
} from "@/ui/settings-page.tsx";
import { TitleTag } from "@/ui/title-tag.tsx";
import { Toggle } from "@/ui/toggle.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";
import { ModelChoiceList } from "./ModelChoiceList.tsx";
import { ProviderSignInRow } from "./ProviderSignIn.tsx";
import { ProviderFieldRow, savedKeyMask, valueText } from "./provider-field-row.tsx";

/*
 * One provider: how it is reached, which of its models bots may use, and
 * disconnecting it. A switched-off model is still listed, in its place, so
 * turning one on or off never moves the list under your pointer.
 */

/**
 * A provider's tile: its official logo for a built-in provider, and its first letter for
 * a custom provider, which has only a name.
 */
export function ProviderTile({
	name,
	builtIn,
	size = 28,
}: {
	name: string;
	builtIn: BuiltInProviderId | null;
	size?: 28 | 44;
}) {
	const large = size === 44;
	const tile = large ? "size-11 rounded-xl border-0 bg-chip text-sm" : undefined;
	if (!builtIn) return <LetterTile name={name} className={tile} />;
	return (
		<SettingsRowIcon className={tile}>
			<ProviderLogo builtIn={builtIn} className={large ? "size-5.5" : "size-3.5"} />
		</SettingsRowIcon>
	);
}

/** The bots on a model, as overlapping faces with a count past the first few. */
function BotFaces({ bots }: { bots: readonly Bot[] }) {
	if (bots.length === 0) return null;
	const shown = bots.slice(0, bots.length > 3 ? 2 : 3);
	const more = bots.length - shown.length;
	return (
		<span aria-hidden className="flex shrink-0 items-center">
			{shown.map((bot, index) => (
				<BotAvatar
					key={bot.id}
					color={bot.color}
					eyes={bot.eyes}
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

/**
 * How a row of faces is laid out: centred under a dialog's text, or small
 * beside a dropdown in a settings row. `fit` is the most faces that fit in
 * one row, on a phone too.
 */
const FACE_ROWS = {
	dialog: { size: 28, fit: 8, className: "justify-center gap-1.5" },
	row: { size: 20, fit: 4, className: "justify-start gap-1" },
} as const;

/**
 * The bots in `bots` as one row of faces, each named on hover or keyboard
 * focus. Past a row, the last place counts the others and names them on hover.
 */
function NamedBotFaces({
	bots,
	label,
	layout = "dialog",
}: {
	bots: readonly Bot[];
	label: string;
	layout?: keyof typeof FACE_ROWS;
}) {
	const { size, fit, className } = FACE_ROWS[layout];
	const faced = bots.length > fit ? bots.slice(0, fit - 1) : bots;
	const others = bots.slice(faced.length);
	return (
		<LivelyGroup>
			<ul
				aria-label={label}
				// Room around each face for its focus ring and its hop.
				className={cn("-m-1.5 flex list-none items-center p-1.5", className)}
			>
				{faced.map((bot) => (
					<li key={bot.id} className="flex">
						<NamedBotFace bot={bot} size={size} />
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
function OtherBots({ bots }: { bots: readonly Bot[] }) {
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
				{countOf(bots.length, "other", "others")}
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
function OtherBotsList({ bots }: { bots: readonly Bot[] }) {
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
			className={cn(
				"focus-ring -mx-1 flex max-h-64 list-none flex-col gap-1 overflow-y-auto rounded-sm px-1 py-0.5",
				moreBelow && "mask-b-from-75%",
			)}
		>
			{bots.map((bot) => (
				<li key={bot.id} className="flex items-center gap-1.5">
					<BotAvatar color={bot.color} eyes={bot.eyes} shape={bot.shape} size={16} />
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
function NamedBotFace({ bot, size }: { bot: Bot; size: number }) {
	const face = useRef<LivelyFace>(null);
	return (
		<Tooltip label={bot.name} side="top" onOpenChange={nameOnKeyboardFocusOnly}>
			<span
				role="img"
				aria-label={bot.name}
				// biome-ignore lint/a11y/noNoninteractiveTabindex: its name shows only on hover or focus, so it must be reachable from the keyboard.
				tabIndex={0}
				className="focus-ring flex rounded-full"
				onPointerEnter={() => face.current?.hop()}
				onFocus={(event) => event.currentTarget.matches(":focus-visible") && face.current?.hop()}
			>
				<TurnTakingAvatar bot={bot} size={size} faceRef={face} />
			</span>
		</Tooltip>
	);
}

/** The bots members talk to among `bots` on `modelId`. */
function memberFacingBotsOn(bots: readonly Bot[], modelId: string): Bot[] {
	return bots.filter((bot) => bot.model === modelId);
}

/**
 * What must keep running on each model id: new bots, which start on the
 * workspace's default, and the system bots. Switching such a model off, or its
 * provider, moves them to another as it goes; the server refuses any other
 * change that would stop offering it, such as removing its provider's key.
 */
function useModelHolders(): (modelId: string) => ModelHolders | undefined {
	const defaultModel = useModels().data?.defaultModel ?? null;
	const systemBotList = useSystemBots().data ?? [];
	return (modelId) => {
		const newBots = modelId === defaultModel;
		const systemBots = systemBotList.some((bot) => bot.model === modelId);
		return newBots || systemBots ? { newBots, systemBots } : undefined;
	};
}

interface ModelHolders {
	newBots: boolean;
	systemBots: boolean;
}

/** Why a model, or its provider, cannot be switched off. */
function heldReason({ newBots, systemBots }: ModelHolders, subject: string): string {
	const holders =
		newBots && systemBots
			? "New bots and system bots use"
			: newBots
				? "New bots use"
				: "System bots use";
	return `${holders} ${subject}. Choose another model for them under Models → Defaults first.`;
}

export function ProviderSettings({ providerId }: { providerId: string }) {
	const providers = useModelProviders();
	if (providers.isPending) return null;
	const provider = providers.data?.find((one) => one.id === providerId);
	if (!provider) {
		return (
			<EmptyState
				page="min"
				title={providers.error ? "Could not load this provider" : "No such provider"}
			>
				{providers.error
					? failureMessage(providers.error)
					: "It may have been disconnected. Its models are no longer offered."}
			</EmptyState>
		);
	}
	return <ProviderPage key={provider.id} provider={provider} />;
}

function ProviderPage({ provider }: { provider: ModelProvider }) {
	const actions = useProviderActions();
	const router = useRouter();
	const { leaveForPage } = useLeave();
	const [disconnecting, setDisconnecting] = useState(false);
	const builtIn = provider.builtIn === null ? null : providerBuiltIn(provider.builtIn);
	// The ones every workspace starts with cannot be deleted, so disconnecting
	// one takes its key or sign-in away and switches it off, and adding it again brings it back.
	const seeded = provider.builtIn !== null && seededBuiltIns.includes(provider.builtIn);
	const signsIn = builtInSignsIn(provider.builtIn);
	const disconnect = seeded ? actions.update : actions.remove;
	const disconnectPending = disconnect.isPending || actions.signOut.isPending;
	const disconnectError = disconnect.error ?? actions.signOut.error;
	// Switching a provider off only stops what it offers; removing one deletes
	// every model it lists, including one held while the provider is off.
	const held = useHoldersOf(seeded ? offeredModelsOf(provider) : provider.models);
	const heldOn = useHoldersOf(offeredModelsOf(provider));
	const usage = useModelUsage();
	const [checkingUsage, setCheckingUsage] = useState(false);
	// Kept as they were when the dialog opened: once they move, the provider goes
	// off and would strand none, emptying the dialog while it disconnects.
	const [movingBots, setMovingBots] = useState<{
		action: "switch off" | "disconnect";
		stranded: StrandedModel[];
		held: ModelHolders | undefined;
	}>();
	const disconnectWarning = seeded
		? `${signsIn ? "It is signed out" : "Its key is removed"} and bots can no longer use its models. You can connect it again at any time.`
		: "Bots can no longer use its models. Adding it again means entering its details again.";

	/** The models switching the provider off would leave bots on, from fresh usage. */
	async function latestStranded() {
		setCheckingUsage(true);
		const latest = await usage.latest().finally(() => setCheckingUsage(false));
		return strandedModelsOf(provider, latest);
	}

	async function switchOff() {
		const stranded = await latestStranded();
		if (stranded.length > 0 || heldOn) {
			setMovingBots({ action: "switch off", stranded, held: heldOn });
			return;
		}
		actions.update.mutate({ providerId: provider.id, json: { active: false } });
	}

	async function disconnectProvider() {
		if (!seeded) {
			await actions.remove.mutateAsync({ providerId: provider.id });
			return;
		}
		if (provider.signedIn) {
			await actions.signOut.mutateAsync({ providerId: provider.id });
		}
		await actions.update.mutateAsync({
			providerId: provider.id,
			json: { active: false, ...(provider.hasApiKey ? { apiKey: null } : {}) },
		});
	}

	async function confirmDisconnect() {
		try {
			await disconnectProvider();
		} catch {
			return;
		}
		leaveDisconnected();
	}

	function leaveDisconnected() {
		setDisconnecting(false);
		// Back to Models, or Models in the provider's place, so Back never returns to one
		// no longer connected.
		leaveForPage(router.buildLocation(settingsSectionLink("providers")).href);
	}

	return (
		<SettingsPage
			back={<BackToModels />}
			backOnWide
			hero={<ProviderTile name={provider.name} builtIn={provider.builtIn} size={44} />}
			title={provider.name}
			description={[
				// A built-in provider every workspace starts with was seeded, not added: its date is when the
				// workspace got it, not when anybody connected it.
				!seeded && `Added ${formatTimeAfterVerb(new Date(provider.createdAt), new Date())}`,
				provider.connectedBy && `Connected by ${provider.connectedBy.name}`,
			]
				.filter(Boolean)
				.join(" · ")}
		>
			<SettingsGroup
				note={
					actions.update.error
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
							disabled={
								actions.update.isPending ||
								checkingUsage ||
								// Until usage is known, switching off could leave bots on its models unasked.
								(provider.active && !usage.known)
							}
							label={`Use ${provider.name}`}
							onChange={(active) =>
								active
									? actions.update.mutate({ providerId: provider.id, json: { active } })
									: switchOff()
							}
						/>
					}
				/>
			</SettingsGroup>
			<ProviderAccessGroup provider={provider} local={builtIn?.hosting === "local"} />
			<Models provider={provider} />
			<SettingsDanger
				label={`Disconnect ${provider.name}`}
				description="Bots using these models move to the ones you pick."
				action="Disconnect"
				onClick={async () => {
					const stranded = await latestStranded();
					if (stranded.length > 0 || held) setMovingBots({ action: "disconnect", stranded, held });
					else setDisconnecting(true);
				}}
				disabledReason={!usage.known || checkingUsage ? "Loading bots…" : undefined}
			/>
			<Dialog
				open={movingBots !== undefined}
				onOpenChange={(open) => !open && setMovingBots(undefined)}
			>
				{movingBots && (
					<MoveBotsOffProviderDialog
						provider={provider}
						stranded={movingBots.stranded}
						held={movingBots.held}
						then={movingBots.action}
						warning={movingBots.action === "disconnect" ? disconnectWarning : undefined}
						onMoved={async () => {
							if (movingBots.action === "disconnect") {
								await disconnectProvider();
								leaveDisconnected();
							}
							setMovingBots(undefined);
						}}
						done={() => setMovingBots(undefined)}
					/>
				)}
			</Dialog>
			<DeleteDialog
				open={disconnecting}
				onOpenChange={setDisconnecting}
				title={`Disconnect ${provider.name}?`}
				description={disconnectWarning}
				confirmLabel="Disconnect"
				pending={disconnectPending}
				error={disconnectError ? failureMessage(disconnectError) : undefined}
				onDelete={confirmDisconnect}
			/>
		</SettingsPage>
	);
}

export function BackToModels() {
	const backToModels = useBackToLinkedPage();
	return (
		<PageBackLink
			label="Models"
			render={
				<Link
					{...settingsSectionLink("providers")}
					aria-label="Back to Models"
					onClick={backToModels}
				/>
			}
		/>
	);
}

/**
 * How the provider is reached. A hosted one is its key, or for a
 * subscription a sign-in; one you run is its address and an optional key; a custom one also
 * says which API it speaks.
 */
function ProviderAccessGroup({ provider, local }: { provider: ModelProvider; local: boolean }) {
	const actions = useProviderActions();
	const custom = provider.builtIn === null;
	const signInService = builtInSignInService(provider.builtIn);
	const error = actions.update.error ?? actions.test.error;
	const tested = actions.test.data;
	const held = useHoldersOf(offeredModelsOf(provider));

	return (
		<SettingsGroup
			label="Access"
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
						Test provider
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
					problemWith={(typed) => (parseProviderBaseUrl(typed) ? undefined : NOT_A_SERVER_ADDRESS)}
					onSave={async (typed) => {
						await actions.update.mutateAsync({
							providerId: provider.id,
							json: { baseUrl: parseProviderBaseUrl(typed) },
						});
					}}
				/>
			)}
			{custom && (
				<ProviderFieldRow
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
				/>
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
			{error && <SettingsRowAlert>{failureMessage(error)}</SettingsRowAlert>}
		</SettingsGroup>
	);
}

/**
 * How the last test went, as a dot and a few words beside Test provider:
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
			{reachable ? "Provider answered" : (error ?? "Provider didn't answer.")}
		</SettingsTestOutcome>
	);
}

/** The two APIs a custom provider can speak. */
export const API_FORMATS = [
	{ value: "openai", label: "OpenAI" },
	{ value: "anthropic", label: "Anthropic" },
] as const;

const fieldText =
	"w-full min-w-0 bg-transparent font-mono text-xs rounded-sm text-foreground focus-ring placeholder:text-muted-foreground";

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
			<ProviderFieldRow
				label={label}
				action={
					<Button variant="link" size="text" onClick={() => setDraft(value)}>
						Change
					</Button>
				}
			>
				<span className={valueText}>{value}</span>
			</ProviderFieldRow>
		);
	}
	return (
		<ProviderFieldForm
			label={label}
			field={{
				value: draft,
				onChange: (event) => setDraft(event.target.value),
				placeholder,
			}}
			submitDisabled={pending}
			problem={problem}
			onSubmit={save}
			onCancel={() => setDraft(undefined)}
		/>
	);
}

/**
 * A provider's row while it is typed into: its field, Save or `submitLabel`,
 * Cancel when it can be, and what went wrong under the field.
 */
function ProviderFieldForm({
	label,
	fieldLabel = label,
	field,
	submitLabel = "Save",
	submitDisabled,
	problem,
	onSubmit,
	onCancel,
}: {
	label: string;
	/** Names the field for a screen reader, where `label` alone is too little. */
	fieldLabel?: string;
	field: ComponentProps<"input">;
	submitLabel?: string;
	submitDisabled: boolean;
	problem: string | undefined;
	onSubmit: (event: FormEvent) => void;
	onCancel?: () => void;
}) {
	return (
		<form onSubmit={onSubmit}>
			<ProviderFieldRow
				label={label}
				action={
					<span className="flex shrink-0 items-center gap-3">
						<Button variant="link" size="text" type="submit" disabled={submitDisabled}>
							{submitLabel}
						</Button>
						{onCancel && (
							<Button variant="ghost" size="text" type="button" onClick={onCancel}>
								Cancel
							</Button>
						)}
					</span>
				}
			>
				<input aria-label={fieldLabel} autoComplete="off" className={fieldText} {...field} />
				{problem && (
					<span role="alert" className="block pt-1 text-destructive-text text-xs">
						{problem}
					</span>
				)}
			</ProviderFieldRow>
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

/**
 * The workspace's bots: `known` once they and the models they could move to
 * have loaded, and `latest` to refetch both before acting, as the cached ones
 * may predate another tab's changes.
 */
function useModelUsage() {
	const bots = useBots();
	const models = useModels();
	return {
		bots: bots.bots ?? [],
		known: bots.bots !== undefined && models.data !== undefined,
		latest: async (): Promise<readonly Bot[]> => {
			const [latestBots] = await Promise.all([bots.refetch(), models.refetch()]);
			return latestBots.data ?? [];
		},
	};
}

type OfferedModel = WorkspaceModelsResponse["models"][number];

type SettingMoves = Pick<ProviderSwitchOff, "newBotsTo" | "systemBotsTo">;

/**
 * Where what runs on models going off can move: `candidates`, the switched-on
 * models but those `leaving`, and the moves of the workspace's settings in
 * `held`. Each setting moves only as it is chosen, never with the bots, so the
 * default changes only when someone means it to.
 */
function useMoveChoices(
	held: ModelHolders | undefined,
	leaving: (candidate: OfferedModel) => boolean,
) {
	const models = useModels().data;
	const candidates = (models?.models ?? []).filter((candidate) => !leaving(candidate));
	// The one new bots use, if it is among them, else the first.
	const suggested = candidates.some((candidate) => candidate.modelId === models?.defaultModel)
		? (models?.defaultModel ?? undefined)
		: candidates[0]?.modelId;
	/** `picked` while it is still offered, else the suggested one, so a pick switched off since falls back. */
	const offeredOr = (picked: string | undefined) =>
		candidates.some((candidate) => candidate.modelId === picked) ? picked : suggested;
	const [chosenSettings, setChosenSettings] = useState<SettingMoves>({});
	const settingMoves: SettingMoves = {
		newBotsTo: held?.newBots ? offeredOr(chosenSettings.newBotsTo) : undefined,
		systemBotsTo: held?.systemBots ? offeredOr(chosenSettings.systemBotsTo) : undefined,
	};
	return {
		candidates,
		offeredOr,
		settingMoves,
		changeSettingMoves: (change: SettingMoves) =>
			setChosenSettings((was) => ({ ...was, ...change })),
	};
}

/** What `held` names, as a sentence would: new bots, compaction, or both. */
function holderNames({ newBots, systemBots }: ModelHolders): string[] {
	return [...(newBots ? ["new bots"] : []), ...(systemBots ? ["compaction"] : [])];
}

/** A model to move something to, picked from `candidates` in a menu. */
function MoveToMenu({
	label,
	candidates,
	value,
	onChange,
}: {
	/** What moves, as the menu button announces it: "Move new bots to". */
	label: string;
	candidates: readonly OfferedModel[];
	value: string | undefined;
	onChange: (modelId: string) => void;
}) {
	const chosen = candidates.find((candidate) => candidate.modelId === value);
	const name = chosen ? modelName(chosen) : value;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label={`${label}: ${name}`}
				className="focus-ring flex h-8 min-w-0 max-w-48 cursor-pointer items-center gap-1.5 rounded-md bg-chip px-2.5 text-sm text-foreground transition-colors hover:bg-hover"
			>
				<span className="truncate">{name}</span>
				<ChevronDown aria-hidden size={14} className="shrink-0 text-muted-foreground" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="max-h-80 min-w-48">
				<DropdownMenuRadioGroup
					value={value}
					onValueChange={(modelId: string) => onChange(modelId)}
				>
					{candidates.map((candidate) => (
						<DropdownMenuRadioItem
							key={`${candidate.providerId}:${candidate.modelId}`}
							value={candidate.modelId}
						>
							{modelName(candidate)}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** A row for each workspace setting on a model being switched off, with the model it moves to. */
function SettingMoveRows({
	held,
	candidates,
	moves,
	onChange,
}: {
	held: ModelHolders;
	candidates: readonly OfferedModel[];
	moves: SettingMoves;
	onChange: (change: SettingMoves) => void;
}) {
	return (
		<>
			{held.newBots && (
				<SettingsRow
					label="New bots"
					sub="The model new bots start on"
					trailing={
						<MoveToMenu
							label="Move new bots to"
							candidates={candidates}
							value={moves.newBotsTo}
							onChange={(newBotsTo) => onChange({ newBotsTo })}
						/>
					}
				/>
			)}
			{held.systemBots && (
				<SettingsRow
					label="System bots"
					sub="Built-in system tasks, like compacting long chats"
					trailing={
						<MoveToMenu
							label="Move system bots to"
							candidates={candidates}
							value={moves.systemBotsTo}
							onChange={(systemBotsTo) => onChange({ systemBotsTo })}
						/>
					}
				/>
			)}
		</>
	);
}

interface StrandedModel {
	model: ProviderModel;
	bots: Bot[];
}

/** The provider's offered models that bots would be left on if it went off. */
function strandedModelsOf(provider: ModelProvider, workspaceBots: readonly Bot[]): StrandedModel[] {
	return offeredModelsOf(provider).flatMap((model) => {
		const bots = memberFacingBotsOn(workspaceBots, model.modelId);
		return bots.length > 0 ? [{ model, bots }] : [];
	});
}

/**
 * Switching off or disconnecting a provider whose models bots, new bots or
 * compaction still run on: where each moves, from the models other providers
 * offer, starting on the one new bots use. They move and the provider goes off
 * together, so nothing is left on a model that is off.
 */
function MoveBotsOffProviderDialog({
	provider,
	stranded,
	held,
	then,
	warning,
	onMoved,
	done,
}: {
	provider: ModelProvider;
	stranded: readonly StrandedModel[];
	held: ModelHolders | undefined;
	then: "switch off" | "disconnect";
	/** What else happens, said as the plain confirmation would. */
	warning?: string;
	/** After the bots have moved and the provider is off. */
	onMoved: () => Promise<void>;
	done: () => void;
}) {
	const actions = useProviderActions();
	const { candidates, offeredOr, settingMoves, changeSettingMoves } = useMoveChoices(
		held,
		(candidate) => candidate.providerId === provider.id,
	);
	const [chosen, setChosen] = useState<Record<string, string>>({});
	const destinationOf = (modelId: string) => offeredOr(chosen[modelId]);
	const moveBots = stranded.flatMap(({ model }) => {
		const to = destinationOf(model.modelId);
		return to ? [{ from: model.modelId, to }] : [];
	});
	const [error, setError] = useState<unknown>();
	const [pending, setPending] = useState(false);
	const botCount = stranded.reduce((total, { bots }) => total + bots.length, 0);
	const verb = then === "disconnect" ? "disconnect" : "switch off";
	const users = [
		...(botCount > 0 ? [countOf(botCount, "bot", "bots")] : []),
		...(held ? holderNames(held) : []),
	];
	const uses = users.length === 1 && botCount === 1 ? "uses" : "use";

	async function submit(event: FormEvent) {
		event.preventDefault();
		setError(undefined);
		setPending(true);
		try {
			await actions.switchOff.mutateAsync({ providerId: provider.id, moveBots, ...settingMoves });
			await onMoved();
		} catch (cause) {
			setError(cause);
		} finally {
			setPending(false);
		}
	}

	return (
		<DialogForm width="compact" onSubmit={submit}>
			<DialogFormHeader
				title={
					then === "disconnect" ? `Disconnect ${provider.name}` : `Switch off ${provider.name}`
				}
			/>
			<DialogFormBody>
				<DialogDescription>
					{capitalise(LIST.format(users))} {uses} {provider.name}'s models. Choose the model each
					moves to.
				</DialogDescription>
				{warning && <DialogDescription>{warning}</DialogDescription>}
				{candidates.length === 0 ? (
					<Alert>Switch on a model at another provider first, so there is one to move to.</Alert>
				) : (
					<SettingsGroup>
						{stranded.map(({ model, bots }) => {
							return (
								<SettingsRow
									key={model.id}
									label={modelName(model)}
									sub={
										<NamedBotFaces bots={bots} label={`Bots on ${modelName(model)}`} layout="row" />
									}
									trailing={
										<MoveToMenu
											label={`Move ${modelName(model)} bots to`}
											candidates={candidates}
											value={destinationOf(model.modelId)}
											onChange={(modelId) => setChosen({ ...chosen, [model.modelId]: modelId })}
										/>
									}
								/>
							);
						})}
						{held && (
							<SettingMoveRows
								held={held}
								candidates={candidates}
								moves={settingMoves}
								onChange={changeSettingMoves}
							/>
						)}
					</SettingsGroup>
				)}
				{error !== undefined && <Alert>{failureMessage(error)}</Alert>}
			</DialogFormBody>
			<DialogFormFooter
				action={held ? `Move and ${verb}` : `Move bots and ${verb}`}
				actionDisabled={candidates.length === 0 || pending}
				onCancel={done}
			/>
		</DialogForm>
	);
}

/** The models the provider offers bots: none unless it is usable, connected and switched on. */
function offeredModelsOf(provider: ModelProvider): ProviderModel[] {
	return providerIsUsable(provider) ? provider.models.filter((model) => model.enabled) : [];
}

/** The key, masked once saved; Replace swaps it for a new one. */
function KeyRow({ provider, optional }: { provider: ModelProvider; optional: boolean }) {
	const actions = useProviderActions();
	const held = useHoldersOf(offeredModelsOf(provider));
	const [replacing, setReplacing] = useState(!provider.hasApiKey && !optional);
	const [apiKey, setApiKey] = useState("");

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
			<ProviderFieldRow
				label="API key"
				action={
					<span className="flex shrink-0 items-center gap-3">
						{optional && provider.hasApiKey && (
							<Button
								variant="ghost"
								size="text"
								disabled={actions.update.isPending || held !== undefined}
								title={held && heldReason(held, "one of its models")}
								onClick={() =>
									actions.update.mutate({ providerId: provider.id, json: { apiKey: null } })
								}
							>
								Remove
							</Button>
						)}
						<Button variant="link" size="text" onClick={() => setReplacing(true)}>
							{provider.hasApiKey ? "Replace" : "Add"}
						</Button>
					</span>
				}
			>
				<span className={valueText}>{provider.hasApiKey ? savedKeyMask : "None"}</span>
			</ProviderFieldRow>
		);
	}
	return (
		<ProviderFieldForm
			label="API key"
			fieldLabel={`${provider.name} API key`}
			field={{
				type: "password",
				value: apiKey,
				onChange: (event) => setApiKey(event.target.value),
				placeholder: "Paste your key",
			}}
			submitDisabled={!apiKey || actions.update.isPending}
			problem={actions.update.error ? failureMessage(actions.update.error) : undefined}
			onSubmit={save}
			onCancel={
				provider.hasApiKey || optional
					? () => {
							setApiKey("");
							setReplacing(false);
						}
					: undefined
			}
		/>
	);
}

const capabilityIcons: Record<ProviderModelCapability, LucideIcon> = {
	tools: Wrench,
	vision: Eye,
	images: Image,
	audio: Mic,
	thinking: Brain,
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
						<Tooltip key={entry.key} label={entry.name}>
							<Icon
								role="img"
								aria-label={entry.name}
								className="size-3.25 shrink-0"
								strokeWidth={2}
							/>
						</Tooltip>
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
	const usage = useModelUsage();
	const holdersOf = useModelHolders();
	const [search, setSearch] = useState("");
	const [adding, setAdding] = useState(false);
	const [checkingUsage, setCheckingUsage] = useState(false);
	const [movingOff, setMovingOff] = useState<ProviderModel>();
	const needle = useDeferredValue(search.trim().toLowerCase());
	const large = provider.models.length > MODEL_SEARCH_THRESHOLD;
	// Switched-on models lead, as they were when the page opened, so a row never moves under the toggle just used.
	const [onWhenOpened] = useState(
		() => new Set(provider.models.filter((model) => model.enabled).map((model) => model.id)),
	);
	const shown = searchModels(provider.models, needle).sort(
		(a, b) => Number(onWhenOpened.has(b.id)) - Number(onWhenOpened.has(a.id)),
	);
	const error = actions.setModel.error ?? actions.discoverModels.error;
	const custom = provider.builtIn === null;

	/**
	 * Switches the model off, or asks where its bots, new bots or compaction go
	 * first. Decided on fresh bots and models, as the cached ones may predate
	 * another tab's changes.
	 */
	async function switchOff(model: ProviderModel) {
		setCheckingUsage(true);
		const latest = await usage.latest().finally(() => setCheckingUsage(false));
		const strandsBots = memberFacingBotsOn(latest, model.modelId).length > 0;
		if (strandsBots || holdersOf(model.modelId) !== undefined) {
			setMovingOff(model);
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
					size="text"
					disabled={actions.discoverModels.isPending || providerLacksCredential(provider)}
					onClick={() => actions.discoverModels.mutate({ providerId: provider.id })}
				>
					{actions.discoverModels.isPending ? "Refreshing…" : "Refresh list"}
				</Button>
			}
			note="Only switched-on models show up when choosing a bot's model."
		>
			{large && (
				<div className="border-border border-b p-2.5">
					<SearchField
						label="Search models"
						placeholder={`Search ${provider.models.length} models`}
						look="outline"
						value={search}
						onChange={setSearch}
					/>
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
					const bots = memberFacingBotsOn(usage.bots, model.modelId);
					const used = bots.length === 0 ? "Not used yet" : countOf(bots.length, "bot", "bots");
					const who = large ? makerLabel(makerOf(model) ?? provider.name) : used;
					const held = model.enabled ? holdersOf(model.modelId) : undefined;
					return (
						<SettingsRow
							key={model.id}
							label={
								// Beside its name, what the workspace's defaults hold it for.
								<span className="flex min-w-0 items-center gap-1.5">
									<span className="truncate">{modelName(model)}</span>
									{held?.newBots && <TitleTag>Default</TitleTag>}
									{held?.systemBots && <TitleTag>System bots</TitleTag>}
								</span>
							}
							sub={
								<span className="flex items-center gap-1.5">
									{who}
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
											// Until usage is known, switching off could leave bots on it unasked.
											(model.enabled && !usage.known)
										}
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
				open={movingOff !== undefined}
				onOpenChange={(open) => !open && setMovingOff(undefined)}
			>
				{movingOff && (
					<MoveBotsDialog
						provider={provider}
						model={movingOff}
						bots={memberFacingBotsOn(usage.bots, movingOff.modelId)}
						held={holdersOf(movingOff.modelId)}
						done={() => setMovingOff(undefined)}
					/>
				)}
			</Dialog>
			{custom &&
				(adding ? (
					<AddModelRow provider={provider} done={() => setAdding(false)} />
				) : (
					<SettingsAddRow label="Add model" onClick={() => setAdding(true)} />
				))}
			{error && <SettingsRowAlert>{failureMessage(error)}</SettingsRowAlert>}
		</SettingsGroup>
	);
}

/**
 * Switching off a model bots, new bots or compaction still run on: which of the
 * other switched-on models each moves to, starting on the one new bots use.
 * They move and the model goes off together, so nothing is left on a model
 * that is off.
 */
function MoveBotsDialog({
	provider,
	model,
	bots,
	held,
	done,
}: {
	provider: ModelProvider;
	model: ProviderModel;
	bots: readonly Bot[];
	held: ModelHolders | undefined;
	done: () => void;
}) {
	const actions = useProviderActions();
	const { candidates, offeredOr, settingMoves, changeSettingMoves } = useMoveChoices(
		held,
		(candidate) => candidate.modelId === model.modelId,
	);
	const [search, setSearch] = useState("");
	const needle = useDeferredValue(search.trim().toLowerCase());
	const [picked, setPicked] = useState<string>();
	// Follows the models as they load or change, until someone picks one.
	const chosen = offeredOr(picked);
	const shown = searchModels(candidates, needle);
	const name = modelName(model);
	const hasBots = bots.length > 0;

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!chosen) return;
		try {
			await actions.switchOffModel.mutateAsync({
				providerId: provider.id,
				modelId: model.id,
				moveBotsTo: hasBots ? chosen : undefined,
				...settingMoves,
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
					{hasBots
						? `${bots.length === 1 ? "This bot uses" : "These bots use"} ${name}${held ? `, and so do ${LIST.format(holderNames(held))}` : ""}.`
						: `${capitalise(LIST.format(held ? holderNames(held) : []))} use ${name}.`}
					{candidates.length > 0 &&
						(hasBots
							? ` Choose the model to move ${bots.length === 1 && !held ? "it" : "them"} to.`
							: " Choose the model each moves to.")}
				</DialogDescription>
				{hasBots && <NamedBotFaces bots={bots} label={`Bots on ${name}`} />}
				{candidates.length === 0 ? (
					<Alert>
						{name} is the only model switched on. Switch on another first, so there is one to move
						to.
					</Alert>
				) : (
					<>
						{hasBots && candidates.length > MODEL_SEARCH_THRESHOLD && (
							<SearchField
								label="Search models"
								placeholder={`Search ${candidates.length} models`}
								look="outline"
								value={search}
								onChange={setSearch}
							/>
						)}
						{hasBots && (
							<DialogFormScroll height="picker-tall">
								<ModelChoiceList
									models={shown}
									chosen={chosen}
									onChoose={setPicked}
									empty="No models match."
								/>
							</DialogFormScroll>
						)}
						{held && (
							<SettingsGroup>
								<SettingMoveRows
									held={held}
									candidates={candidates}
									moves={settingMoves}
									onChange={changeSettingMoves}
								/>
							</SettingsGroup>
						)}
					</>
				)}
				{actions.switchOffModel.error && (
					<Alert>{failureMessage(actions.switchOffModel.error)}</Alert>
				)}
			</DialogFormBody>
			<DialogFormFooter
				action={
					held
						? "Move and switch off"
						: bots.length === 1
							? "Move bot and switch off"
							: "Move bots and switch off"
				}
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
	return (
		<ProviderFieldForm
			label="Model ID"
			field={{
				value: modelId,
				onChange: (event) => setModelId(event.target.value),
				placeholder: "e.g. llama-3.3-70b",
			}}
			submitLabel="Add"
			submitDisabled={!modelId.trim() || actions.addModel.isPending}
			problem={actions.addModel.error ? failureMessage(actions.addModel.error) : undefined}
			onSubmit={(event) => {
				event.preventDefault();
				if (!modelId.trim()) return;
				actions.addModel.mutate(
					{ providerId: provider.id, modelId: modelId.trim() },
					{ onSuccess: done },
				);
			}}
			onCancel={done}
		/>
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
