import { botColorVariables } from "@sugabots/avatars";
import {
	BOT_NAME_MAX_LENGTH,
	type Bot,
	type BotColor,
	type BotEyes,
	type BotShape,
	builtInSignInService,
	effectiveCapabilities,
	type ModelProvider,
	type ProviderModel,
	providerBuiltIn,
	providerIsReady,
	providerLacksCredential,
	slugify,
	WORKSPACE_NAME_MAX_LENGTH,
	type Workspace,
} from "@sugabots/contracts";
import { useBlocker, useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import { X } from "lucide-react";
import {
	type FormEvent,
	type KeyboardEvent,
	type ReactNode,
	type RefObject,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { useBots, useCreateBot, useEnsureAssistant, useModels } from "@/lib/bots.ts";
import { useStartInterview } from "@/lib/chats.ts";
import { failureMessage } from "@/lib/failure.ts";
import { modelName, useModelProviders, useProviderActions } from "@/lib/model-providers.ts";
import { countOf } from "@/lib/name-list.ts";
import { MODEL_SEARCH_THRESHOLD } from "@/lib/screen-limits.ts";
import type { Session } from "@/lib/session.ts";
import {
	chooseWorkspace,
	type InvitationFailure,
	sendInvitations,
	useCreateWorkspace,
	useSendInvitation,
	useUpdateWorkspace,
	useWorkspace,
} from "@/lib/workspace.ts";
import {
	useChooseFirstModel,
	useCompleteWorkspaceSetup,
	useListFirstProviderModels,
} from "@/lib/workspace-setup.ts";
import { AvatarPicker } from "@/shell/AvatarPicker.tsx";
import { BotAvatar } from "@/shell/Bot.tsx";
import { Splash } from "@/shell/Splash.tsx";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { SearchField, useSearchFilter } from "@/ui/search-field.tsx";
import { SettingsGroup, SettingsRow } from "@/ui/settings-page.tsx";
import { AuthBackButton, AuthHeading, QuietLink } from "./AuthLayout.tsx";
import { AddProviderDialog } from "./ModelsSettings.tsx";
import { ProviderTile } from "./ProviderSettings.tsx";
import { ProviderSignInRow } from "./ProviderSignIn.tsx";

/*
 * Setting up a workspace: name it, connect a model, make the first bot, invite
 * members, then meet the bot. Signing in comes before, on the sign-in page, which
 * is the welcome. The first bot is a public bot of its own, beside the
 * member's Personal Assistant, which the workspace already made.
 */

type Step = "workspace" | "model" | "bot" | "invite" | "ready";

/** The steps the dots count. Ready has none: there is nothing left to go back to. */
const counted: readonly Step[] = ["workspace", "model", "bot", "invite"];

interface WorkspaceSetupProps {
	session: Session;
	/** The workspace being set up, once the first step has made it. */
	workspace: Workspace | undefined;
	/**
	 * Hears the address the first step is about to save the workspace at,
	 * before it saves, so a reload while it saves comes back to the same
	 * workspace; and the address it keeps if saving fails.
	 */
	onAddress: (slug: string | undefined) => void;
	/** Leaves setup. Without it there is nowhere to go back to. */
	onCancel?: () => void;
}

/**
 * The steps read the chosen workspace, so the one being set up is chosen
 * before they show: once each time it changes, as on making it or after a
 * reload. Choosing it no more often than that lets Cancel choose another on
 * the way out.
 */
export function WorkspaceSetup(props: WorkspaceSetupProps) {
	const chosen = useWorkspace().workspace;
	const workspaceId = props.workspace?.id;

	useEffect(() => {
		if (workspaceId) chooseWorkspace(workspaceId);
	}, [workspaceId]);

	if (workspaceId && chosen?.id !== workspaceId) return <Splash />;
	return <WorkspaceSetupSteps {...props} />;
}

function WorkspaceSetupSteps({ session, workspace, onAddress, onCancel }: WorkspaceSetupProps) {
	const cancelling = useRef(false);
	const models = useModels(Boolean(workspace));
	const { bots, isPending: botsPending, error: botsError, refetch } = useBots();
	const [chosen, setChosen] = useState<Step>();
	// The Personal Assistant the workspace made for its maker, which the model step sets up,
	// and the first bot they make here, a public one of the workspace's.
	const assistant = bots?.find((bot) => bot.assistant);
	const firstBot = bots?.find(
		(bot) => !bot.assistant && bot.createdBy !== null && bot.createdBy.id === session.member?.id,
	);
	const assistantHasModel =
		models.data?.models.some((model) => model.modelId === assistant?.model) ?? false;
	// Coming back part way through picks up where the workspace says it got to.
	const inferred: Step = !workspace
		? "workspace"
		: !assistantHasModel
			? "model"
			: firstBot
				? "invite"
				: "bot";
	const step = chosen ?? inferred;
	// Made, but not yet among the workspaces read back, so there is none to set up yet.
	const loading =
		(!workspace && step !== "workspace") ||
		(Boolean(workspace) && (models.isPending || botsPending));
	const failure = models.error ?? botsError;
	const index = counted.indexOf(step);
	const back = index > 0 ? counted[index - 1] : undefined;

	return (
		<WorkspaceSetupFrame
			current={index === -1 ? undefined : index}
			onBack={back ? () => setChosen(back) : undefined}
			onCancel={
				onCancel && step !== "ready"
					? () => {
							cancelling.current = true;
							onCancel();
						}
					: undefined
			}
		>
			{workspace && step !== "ready" && (
				<LeavingWorkspaceSetupGuard workspaceName={workspace.name} cancelling={cancelling} />
			)}
			{loading ? (
				<p className="m-0 text-center text-muted-foreground">Loading your setup…</p>
			) : failure ? (
				<div className="flex flex-col gap-4">
					<Alert>{failureMessage(failure)}</Alert>
					<Button
						variant="secondary"
						onClick={() => void Promise.all([models.refetch(), refetch()])}
					>
						Try again
					</Button>
				</div>
			) : step === "workspace" ? (
				<WorkspaceStep
					workspace={workspace}
					firstName={session.member?.name.split(" ")[0]}
					onAddress={onAddress}
					onContinue={() => setChosen("model")}
				/>
			) : step === "model" ? (
				<ModelStep bot={assistant} onContinue={() => setChosen("bot")} />
			) : !workspace || !assistant ? (
				<AssistantMissing modelId={models.data?.models[0]?.modelId} />
			) : step === "bot" ? (
				<BotStep
					model={assistant.model ?? null}
					made={firstBot}
					onCreated={() => setChosen("invite")}
				/>
			) : step === "invite" ? (
				<InviteMembersStep workspaceId={workspace.id} onContinue={() => setChosen("ready")} />
			) : firstBot ? (
				<ReadyStep workspace={workspace} bot={firstBot} />
			) : (
				<BotStep
					model={assistant.model ?? null}
					made={undefined}
					onCreated={() => setChosen("invite")}
				/>
			)}
		</WorkspaceSetupFrame>
	);
}

/**
 * Asks before a link, Back or closing the tab leaves a workspace made but not
 * set up. Cancel is let through: it settles what becomes of the workspace.
 */
function LeavingWorkspaceSetupGuard({
	workspaceName,
	cancelling,
}: {
	workspaceName: string;
	cancelling: RefObject<boolean>;
}) {
	const blocker = useBlocker({
		shouldBlockFn: ({ current, next }) => !cancelling.current && next.pathname !== current.pathname,
		enableBeforeUnload: () => !cancelling.current,
		withResolver: true,
	});
	return (
		<DeleteDialog
			open={blocker.status === "blocked"}
			onOpenChange={(open) => {
				if (!open) blocker.reset?.();
			}}
			title="Leave setup?"
			description={`${workspaceName} has been made but isn't set up yet. It stays in your workspaces, and opening it picks up setup where you left off.`}
			pending={false}
			confirmLabel="Leave"
			onDelete={() => blocker.proceed?.()}
		/>
	);
}

function WorkspaceSetupFrame({
	current,
	onBack,
	onCancel,
	children,
}: {
	/** Which counted step this is, for the dots; none on the last. */
	current?: number;
	onBack?: () => void;
	onCancel?: () => void;
	children: ReactNode;
}) {
	return (
		<main className="flex min-h-full flex-col overflow-auto bg-background text-foreground">
			<header className="grid shrink-0 grid-cols-centered items-center px-8 pt-7 max-md:px-4">
				<span>{onBack && <AuthBackButton onClick={onBack} />}</span>
				{current !== undefined && (
					<ol
						aria-label={`Step ${current + 1} of ${counted.length}`}
						className="m-0 flex list-none items-center gap-1.5 p-0"
					>
						{counted.map((step, index) => (
							<li
								key={step}
								className={cn(
									"h-1.5 rounded-full transition-all",
									index === current
										? "w-5.5 bg-foreground"
										: index < current
											? "w-1.5 bg-muted-foreground"
											: "w-1.5 bg-border-strong",
								)}
							/>
						))}
					</ol>
				)}
				{onCancel && (
					<Button
						variant="link"
						size="bare"
						onClick={onCancel}
						className="col-start-3 justify-self-end text-sm"
					>
						Cancel
					</Button>
				)}
			</header>
			<div className="grid flex-1 place-items-center px-4 py-10">
				<div className="flex w-full max-w-110 flex-col gap-5.5">{children}</div>
			</div>
		</main>
	);
}

/** A field standing on its own in a step, as a rounded box, rather than in a `FormRow`. */
const STANDALONE_FIELD =
	"focus-ring w-full rounded-2xl bg-list px-4 py-3.5 text-sm text-foreground outline-none placeholder:text-muted-foreground";

function WorkspaceStep({
	workspace,
	firstName,
	onAddress,
	onContinue,
}: {
	workspace?: { id: string; name: string; slug: string };
	firstName?: string;
	onAddress: WorkspaceSetupProps["onAddress"];
	onContinue: () => void;
}) {
	const create = useCreateWorkspace();
	const update = useUpdateWorkspace(workspace?.id);
	const [name, setName] = useState(workspace?.name ?? "");
	const trimmed = name.trim();
	const pending = create.isPending || update.isPending;

	async function submit(event: FormEvent) {
		event.preventDefault();
		const slug = slugify(trimmed);
		if (!slug) return;
		if (workspace && trimmed === workspace.name) return onContinue();
		onAddress(slug);
		try {
			if (workspace) await update.mutateAsync({ name: trimmed, slug });
			else await create.mutateAsync({ name: trimmed, slug });
		} catch {
			onAddress(workspace?.slug);
			return;
		}
		onContinue();
	}

	return (
		<form onSubmit={submit} className="flex flex-col gap-5.5">
			<AuthHeading title="Name your workspace">
				It's just you for now. You can invite members later.
			</AuthHeading>
			<input
				aria-label="Workspace name"
				// biome-ignore lint/a11y/noAutofocus: the step asks one question, and this is it.
				autoFocus
				value={name}
				onChange={(event) => setName(event.target.value)}
				maxLength={WORKSPACE_NAME_MAX_LENGTH}
				placeholder={firstName ? `e.g. ${firstName}'s bots` : "e.g. Acme"}
				className={STANDALONE_FIELD}
			/>
			{(create.error || update.error) && (
				<Alert>
					{failureMessage(create.error ?? update.error, {
						Conflict: "That workspace address is already taken.",
					})}
				</Alert>
			)}
			<Button type="submit" size="lg" className="w-full" disabled={!slugify(trimmed) || pending}>
				{pending ? "Saving…" : "Continue"}
			</Button>
		</form>
	);
}

/** Connecting a provider, then choosing which of its models the first bot runs on. */
function ModelStep({ bot, onContinue }: { bot?: Bot; onContinue: () => void }) {
	const providers = useModelProviders().data ?? [];
	// Read from the workspace's providers rather than kept, so a sign-in finished
	// while choosing a model brings its models in.
	const [connectedId, setConnectedId] = useState<string>();
	const connected = providers.find((provider) => provider.id === connectedId);
	return connected ? (
		<ChooseModelStep
			provider={connected}
			bot={bot}
			onChosen={onContinue}
			onOtherProvider={() => setConnectedId(undefined)}
		/>
	) : (
		<ConnectProviderStep providers={providers} onConnected={setConnectedId} />
	);
}

/**
 * Adding a provider the way the Models settings do. Coming back part way, one
 * may already be connected with models to choose from; those are not offered
 * again, so they are listed to continue with.
 */
function ConnectProviderStep({
	providers,
	onConnected,
}: {
	providers: readonly ModelProvider[];
	onConnected: (providerId: string) => void;
}) {
	const listModels = useListFirstProviderModels();
	const { update } = useProviderActions();
	const [adding, setAdding] = useState(false);
	const ready = providers.filter(providerIsReady);

	/** Continues with one already connected, switching it back on if it was switched off. */
	async function continueWith(provider: ModelProvider) {
		if (update.isPending) return;
		// A new try, so an earlier one's failure no longer stands.
		update.reset();
		if (!provider.active) {
			await update.mutateAsync({ providerId: provider.id, json: { active: true } });
		}
		onConnected(provider.id);
	}

	return (
		<div className="flex flex-col gap-5.5">
			<AuthHeading title="Connect a provider">
				Bots think with a model from a provider you already use. Pick one to start; you can add more
				later.
			</AuthHeading>
			{ready.length > 0 && (
				<SettingsGroup label="Connected" headingLevel={2}>
					{ready.map((provider) => (
						<SettingsRow
							key={provider.id}
							icon={<ProviderTile name={provider.name} builtIn={provider.builtIn} />}
							label={provider.name}
							sub={countOf(provider.models.length, "model", "models")}
							chevron
							onClick={() => continueWith(provider).catch(() => {})}
						/>
					))}
				</SettingsGroup>
			)}
			{update.error && <Alert>{failureMessage(update.error)}</Alert>}
			<Button
				size="lg"
				className="w-full"
				onClick={() => {
					update.reset();
					setAdding(true);
				}}
			>
				Choose a provider
			</Button>
			<Dialog open={adding} onOpenChange={setAdding}>
				{adding && (
					<AddProviderDialog
						providers={providers}
						done={() => setAdding(false)}
						onAdded={async (provider) => {
							await listModels(provider.id);
							onConnected(provider.id);
						}}
					/>
				)}
			</Dialog>
		</div>
	);
}

/**
 * Choosing the model the first bot thinks with, from those the provider just
 * connected lists, with the built-in providers' picks first. Only the one chosen is
 * switched on; more can be switched on later in the Models settings.
 */
function ChooseModelStep({
	provider,
	bot,
	onChosen,
	onOtherProvider,
}: {
	provider: ModelProvider;
	bot?: Bot;
	onChosen: () => void;
	onOtherProvider: () => void;
}) {
	const choose = useChooseFirstModel();
	// A subscription provider is added before it is signed in to, and lists its models once it is.
	const signInService = providerLacksCredential(provider)
		? builtInSignInService(provider.builtIn)
		: undefined;
	const group = useId();
	const starters = provider.builtIn
		? providerBuiltIn(provider.builtIn).models.map((model) => model.modelId)
		: [];
	const rank = (model: ProviderModel) => {
		const index = starters.indexOf(model.modelId);
		return index === -1 ? starters.length : index;
	};
	const choices = provider.models
		.filter((model) => !effectiveCapabilities(model).includes("embeddings"))
		.sort((a, b) => rank(a) - rank(b));
	const [chosenId, setChosenId] = useState(
		() => choices.find((model) => model.enabled && model.modelId === bot?.model)?.id,
	);
	const chosen = choices.find((model) => model.id === chosenId);
	const large = choices.length > MODEL_SEARCH_THRESHOLD;
	const search = useSearchFilter(choices, (model) => [model.modelId, model.displayName]);
	const shown = search.matches;

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!chosen) return;
		try {
			await choose.mutateAsync({ providerId: provider.id, model: chosen });
		} catch {
			return;
		}
		onChosen();
	}

	return (
		<form onSubmit={submit} className="flex flex-col gap-5.5">
			<AuthHeading title="Choose a model">
				Your first bot thinks with this. You can switch on more of {provider.name}'s models later.
			</AuthHeading>
			{choices.length === 0 && signInService ? (
				<div className="overflow-hidden rounded-panel bg-list">
					<ProviderSignInRow provider={provider} service={signInService} />
				</div>
			) : choices.length === 0 ? (
				<Alert>
					{provider.name} lists no models yet. Check it has some, or use another provider.
				</Alert>
			) : (
				<fieldset className="m-0 overflow-hidden rounded-panel border-0 bg-list p-0">
					<legend className="sr-only">Model</legend>
					{large && (
						<div className="border-border border-b p-3">
							<SearchField
								label="Search models"
								placeholder={`Search ${choices.length} models`}
								value={search.query}
								onChange={search.setQuery}
							/>
						</div>
					)}
					{/*
					 * A fixed height, so the centred step does not move as the search narrows the list.
					 * About four and a half rows: the cut-off one shows the list scrolls.
					 */}
					<div className={large ? "h-52 overflow-y-auto" : undefined}>
						{shown.length === 0 && (
							<p className="m-0 px-4 py-3 text-muted-foreground text-xs">No models match.</p>
						)}
						{shown.map((model) => (
							<label
								key={model.id}
								className="flex cursor-pointer items-center gap-3 border-border border-b px-4 py-3 last:border-b-0 has-focus-visible:bg-panel hover:bg-panel"
							>
								<span className="min-w-0 flex-1 truncate font-medium text-sm text-foreground">
									{modelName(model)}
								</span>
								<input
									type="radio"
									name={group}
									checked={model.id === chosenId}
									onChange={() => setChosenId(model.id)}
									className="size-5 shrink-0 accent-primary"
								/>
							</label>
						))}
					</div>
				</fieldset>
			)}
			{choose.error && <Alert>{failureMessage(choose.error)}</Alert>}
			<Button type="submit" size="lg" className="w-full" disabled={!chosen || choose.isPending}>
				{choose.isPending ? "Saving…" : "Continue"}
			</Button>
			<QuietLink onClick={onOtherProvider}>Use another provider</QuietLink>
		</form>
	);
}

/**
 * Making the workspace's first bot, a public one, on the model chosen for
 * the Personal Assistant. Coming back to it once made goes on with that one.
 */
function BotStep({
	model,
	made,
	onCreated,
}: {
	model: string | null;
	made: Bot | undefined;
	onCreated: () => void;
}) {
	const create = useCreateBot();
	const [color, setColor] = useState<BotColor>(made?.color ?? "green");
	const [shape, setShape] = useState<BotShape>(made?.shape ?? "circle");
	const [eyes, setEyes] = useState<BotEyes>(made?.eyes ?? "pill");
	const [name, setName] = useState(made?.name ?? "");
	const trimmed = name.trim();

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (made) {
			onCreated();
			return;
		}
		if (!model || !trimmed) return;
		try {
			await create.mutateAsync({
				name: trimmed,
				model,
				color,
				shape,
				eyes,
				visibility: "public",
			});
		} catch {
			return;
		}
		onCreated();
	}

	return (
		<form onSubmit={submit} className="flex flex-col gap-5.5">
			<AuthHeading title="Make your first bot" />
			<div className="flex justify-center">
				<BotAvatar color={color} eyes={eyes} shape={shape} size={96} />
			</div>
			<div className="overflow-hidden rounded-panel bg-list">
				<AvatarPicker
					color={color}
					shape={shape}
					eyes={eyes}
					onColorChange={setColor}
					onShapeChange={setShape}
					onEyesChange={setEyes}
				/>
			</div>
			<input
				aria-label="Name"
				value={name}
				onChange={(event) => setName(event.target.value)}
				maxLength={BOT_NAME_MAX_LENGTH}
				placeholder="Give it a name"
				className={STANDALONE_FIELD}
			/>
			{!model && <Alert>Choose a model first, so the bot has something to think with.</Alert>}
			{create.error && <Alert>{failureMessage(create.error)}</Alert>}
			<Button
				type="submit"
				size="lg"
				className="w-full"
				disabled={(!made && (!model || !trimmed)) || create.isPending}
			>
				{create.isPending ? "Creating…" : made ? "Continue" : "Create bot"}
			</Button>
		</form>
	);
}

/** An address as far as the invitation goes: something, an @, something with a dot. */
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The addresses in what was typed, split at spaces, commas and semicolons, leaving out what isn't one. */
function emailsIn(typed: string): string[] {
	return typed.split(/[\s,;]+/).filter((one) => LOOKS_LIKE_EMAIL.test(one));
}

function InviteMembersStep({
	workspaceId,
	onContinue,
}: {
	workspaceId: string;
	onContinue: () => void;
}) {
	const invite = useSendInvitation(workspaceId);
	const [emails, setEmails] = useState<string[]>([]);
	const [draft, setDraft] = useState("");
	const [failed, setFailed] = useState<InvitationFailure[]>([]);
	const [sending, setSending] = useState(false);
	const inputId = useId();

	function addDraft() {
		const typed = emailsIn(draft);
		if (typed.length === 0) return;
		setEmails((current) => [...new Set([...current, ...typed])]);
		setDraft("");
	}

	function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		if (event.key === "Enter" || event.key === "," || event.key === " ") {
			if (draft.trim() === "") return;
			event.preventDefault();
			addDraft();
		}
		if (event.key === "Backspace" && draft === "" && emails.length > 0) {
			setEmails((current) => current.slice(0, -1));
		}
	}

	async function submit(event: FormEvent) {
		event.preventDefault();
		const all = [...new Set([...emails, ...emailsIn(draft)])];
		if (all.length === 0) {
			onContinue();
			return;
		}
		setSending(true);
		const failures = await sendInvitations(all, "editor", invite.mutateAsync);
		setSending(false);
		if (failures.length === 0) {
			onContinue();
			return;
		}
		// What went out is done; what is left is what to fix or skip.
		setFailed(failures);
		setEmails(failures.map((failure) => failure.email));
		setDraft("");
	}

	const count = emails.length;
	return (
		<form onSubmit={submit} className="flex flex-col gap-5.5">
			<AuthHeading title="Bring your friends">
				Invite members to your workspace. You can add them to projects later.
			</AuthHeading>
			<div className="focus-ring-within flex min-h-13 flex-wrap items-center gap-1.5 rounded-2xl bg-list px-3 py-2.5">
				{emails.map((email) => (
					<span
						key={email}
						className="flex items-center gap-1.5 rounded-full bg-border-strong py-1 pr-1.5 pl-2.5 text-xs"
					>
						{email}
						<IconButton
							size="sm"
							label={`Remove ${email}`}
							onClick={() => setEmails((current) => current.filter((one) => one !== email))}
							className="size-4.5 text-soft-foreground [&_svg]:size-2.5"
						>
							<X aria-hidden strokeWidth={3} />
						</IconButton>
					</span>
				))}
				<label htmlFor={inputId} className="sr-only">
					Email addresses
				</label>
				<input
					id={inputId}
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={onKeyDown}
					onBlur={addDraft}
					placeholder={count === 0 ? "Email addresses" : ""}
					disabled={sending}
					className="min-w-40 flex-1 bg-transparent px-1 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground"
				/>
			</div>
			{failed.length > 0 && (
				<Alert>
					{failed.map((failure) => (
						<span key={failure.email} className="block">
							{failure.email}: {failure.reason}
						</span>
					))}
				</Alert>
			)}
			<Button type="submit" size="lg" className="w-full" disabled={sending}>
				{sending
					? "Sending…"
					: count === 0
						? "Continue"
						: `Send ${countOf(count, "invite", "invites")}`}
			</Button>
			<QuietLink onClick={onContinue}>Skip for now</QuietLink>
		</form>
	);
}

function ReadyStep({ workspace, bot }: { workspace: { id: string; slug: string }; bot: Bot }) {
	const navigate = useNavigate();
	const complete = useCompleteWorkspaceSetup();
	const interview = useStartInterview();

	async function finish() {
		try {
			await complete.mutateAsync({ workspaceId: workspace.id, botId: bot.id });
		} catch {
			return;
		}
		// The new bot asks its maker what it's for in a chat of its own, as its greeting says.
		const chat = await interview.mutateAsync(bot.id).catch(() => null);
		// WorkspaceSetup is outside any workspace, so this names one; the link helpers are for pages inside.
		if (chat) {
			await navigate({
				to: "/$workspace/bots/$bot/chats/$chat",
				params: { workspace: workspace.slug, bot: bot.handle, chat: chat.id },
				replace: true,
			});
			return;
		}
		await navigate({
			to: "/$workspace/bots/$bot",
			params: { workspace: workspace.slug, bot: bot.handle },
			replace: true,
		});
	}

	return (
		<>
			<AuthHeading title={`${bot.name} is ready`} />
			<div
				className="flex flex-col gap-0.75 rounded-3xl bg-list px-4 py-4.5"
				style={botColorVariables(bot.color)}
			>
				<span className="pb-1 pl-10.5 font-medium text-2xs text-muted-foreground">{bot.name}</span>
				<div className="flex items-end gap-2">
					<BotAvatar color={bot.color} eyes={bot.eyes} shape={bot.shape} size={34} />
					<div className="flex min-w-0 flex-col gap-0.75">
						{[
							`Hi, I'm ${bot.name}.`,
							"I've only just been set up. Help me work out what I'm for?",
						].map((line) => (
							<p
								key={line}
								className="m-0 rounded-bubble bg-bot-tint px-3.5 py-2.5 text-sm text-bot-text leading-normal"
							>
								{line}
							</p>
						))}
					</div>
				</div>
			</div>
			{complete.error && <Alert>{failureMessage(complete.error)}</Alert>}
			<Button
				size="lg"
				className="w-full"
				disabled={complete.isPending}
				onClick={() => void finish()}
			>
				Start talking
			</Button>
		</>
	);
}

/**
 * The workspace makes each member's Personal Assistant as they join, so this
 * is a recovery rather than a step: making it again, on the model just
 * connected.
 */
function AssistantMissing({ modelId }: { modelId?: string }) {
	const ensure = useEnsureAssistant();
	return (
		<>
			<AuthHeading title="Your Personal Assistant is missing">
				It is your first bot. Make it again to carry on.
			</AuthHeading>
			{ensure.error && <Alert>{failureMessage(ensure.error)}</Alert>}
			<Button
				size="lg"
				className="w-full"
				disabled={!modelId || ensure.isPending}
				onClick={() => modelId && ensure.mutate(modelId)}
			>
				Make it
			</Button>
		</>
	);
}
