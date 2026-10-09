import { botColorVariables } from "@sugabots/avatars";
import {
	type Agent,
	type AgentColor,
	type AgentFace,
	effectiveCapabilities,
	type ModelProvider,
	type Pod,
	type ProviderModel,
	presetSignInService,
	providerLacksCredential,
	providerPreset,
	slugify,
	type Workspace,
} from "@sugabots/contracts";
import { useBlocker, useNavigate } from "@tanstack/react-router";
import { ChevronLeft, Search, X } from "lucide-react";
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
import { useAgents, useModels, useUpdateAgent } from "@/lib/agents.ts";
import { failureMessage } from "@/lib/failure.ts";
import { useModelProviders } from "@/lib/model-providers.ts";
import {
	useChooseFirstModel,
	useCompleteOnboarding,
	useListFirstProviderModels,
} from "@/lib/onboarding.ts";
import { useEnsurePersonalPod, usePods } from "@/lib/pods.ts";
import type { Session } from "@/lib/session.ts";
import {
	chooseWorkspace,
	useCreateWorkspace,
	useInviteWorkspaceMember,
	useUpdateWorkspace,
	useWorkspace,
} from "@/lib/workspace.ts";
import { isConnected, LARGE_CATALOG, modelName } from "@/screens/ProviderSettings.tsx";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { LookPicker } from "@/shell/LookPicker.tsx";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import { SettingsGroup, SettingsRow } from "@/ui/settings-page.tsx";
import { AddProviderDialog } from "./ModelsSettings.tsx";
import { ProviderTile } from "./ProviderSettings.tsx";
import { ProviderSignInRow } from "./ProviderSignIn.tsx";

/*
 * Setting up a workspace: name it, connect a model, make the first bot, invite
 * people, then meet the bot. Signing in comes before, on the login page, which
 * is the welcome. The first bot is the Personal pod's own, which the workspace
 * made with it, so making it here is giving it a face and a name.
 */

type Step = "workspace" | "model" | "bot" | "invite" | "ready";

/** The steps the dots count. Ready has none: there is nothing left to go back to. */
const counted: readonly Step[] = ["workspace", "model", "bot", "invite"];

interface SetupProps {
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
export function Onboarding(props: SetupProps) {
	const chosen = useWorkspace().workspace;
	const workspaceId = props.workspace?.id;

	useEffect(() => {
		if (workspaceId) chooseWorkspace(workspaceId);
	}, [workspaceId]);

	if (workspaceId && chosen?.id !== workspaceId) return <div className="h-full bg-list" />;
	return <SetupSteps {...props} />;
}

function SetupSteps({ session, workspace, onAddress, onCancel }: SetupProps) {
	const cancelling = useRef(false);
	const pods = usePods();
	const models = useModels(Boolean(workspace));
	const { agents, isPending: agentsPending, error: agentsError, refetch } = useAgents();
	const [chosen, setChosen] = useState<Step>();
	const personalPod = pods.data?.find(
		(pod) => pod.kind === "personal" && pod.ownerId === session.user?.id,
	);
	const firstBot = agents?.find(
		(agent) => agent.podId === personalPod?.id && agent.systemAgentKey === null,
	);
	const botHasModel =
		models.data?.models.some((model) => model.modelId === firstBot?.model) ?? false;
	// Coming back part way through picks up where the workspace says it got to.
	const inferred: Step = !workspace ? "workspace" : botHasModel ? "bot" : "model";
	const step = chosen ?? inferred;
	// Made, but not yet among the workspaces read back, so there is none to set up yet.
	const loading =
		(!workspace && step !== "workspace") ||
		(Boolean(workspace) && (pods.isPending || models.isPending || agentsPending));
	const failure = pods.error ?? models.error ?? agentsError;
	const index = counted.indexOf(step);
	const back = index > 0 ? counted[index - 1] : undefined;

	return (
		<OnboardingFrame
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
				<LeavingSetupGuard workspaceName={workspace.name} cancelling={cancelling} />
			)}
			{loading ? (
				<p className="m-0 text-center text-muted-foreground">Loading your setup…</p>
			) : failure ? (
				<div className="flex flex-col gap-4">
					<Alert>{failureMessage(failure)}</Alert>
					<Button
						variant="secondary"
						onClick={() => void Promise.all([pods.refetch(), models.refetch(), refetch()])}
					>
						Try again
					</Button>
				</div>
			) : step === "workspace" ? (
				<WorkspaceStep
					workspace={workspace}
					firstName={session.user?.name.split(" ")[0]}
					onAddress={onAddress}
					onContinue={() => setChosen("model")}
				/>
			) : step === "model" ? (
				<ModelStep bot={firstBot} onContinue={() => setChosen("bot")} />
			) : !workspace || !personalPod ? (
				<PersonalPodMissing modelId={models.data?.models[0]?.modelId} />
			) : step === "bot" ? (
				<BotStep bot={firstBot} onCreated={() => setChosen("invite")} />
			) : step === "invite" ? (
				<InviteStep workspaceId={workspace.id} onContinue={() => setChosen("ready")} />
			) : firstBot ? (
				<ReadyStep workspace={workspace} pod={personalPod} bot={firstBot} />
			) : null}
		</OnboardingFrame>
	);
}

/**
 * Asks before a link, Back or closing the tab leaves a workspace made but not
 * set up. Cancel is let through: it settles what becomes of the workspace.
 */
function LeavingSetupGuard({
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

function OnboardingFrame({
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
			<header className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center px-8 pt-7 max-md:px-4">
				<span>
					{onBack && (
						<button
							type="button"
							onClick={onBack}
							className="focus-ring inline-flex items-center gap-0.5 rounded-md font-medium text-[14.5px] text-link"
						>
							<ChevronLeft aria-hidden size={16} strokeWidth={2.4} />
							Back
						</button>
					)}
				</span>
				{current !== undefined && (
					<ol
						aria-label={`Step ${current + 1} of ${counted.length}`}
						className="m-0 flex list-none items-center gap-1.5 p-0"
					>
						{counted.map((step, index) => (
							<li
								key={step}
								className={`h-1.5 rounded-full transition-all ${
									index === current
										? "w-[22px] bg-foreground"
										: index < current
											? "w-1.5 bg-muted-foreground"
											: "w-1.5 bg-border-strong"
								}`}
							/>
						))}
					</ol>
				)}
				{onCancel && (
					<button
						type="button"
						onClick={onCancel}
						className="focus-ring col-start-3 justify-self-end rounded-md font-medium text-[14.5px] text-link"
					>
						Cancel
					</button>
				)}
			</header>
			<div className="grid flex-1 place-items-center px-4 py-10">
				<div className="flex w-full max-w-[440px] flex-col gap-[22px]">{children}</div>
			</div>
		</main>
	);
}

function StepHeading({ title, children }: { title: ReactNode; children?: ReactNode }) {
	return (
		<>
			<h1 className="m-0 text-balance text-center font-bold text-[30px] leading-[1.15] tracking-[-0.02em]">
				{title}
			</h1>
			{children && (
				<p className="m-0 text-pretty text-center text-[15px] text-muted-foreground leading-[1.55]">
					{children}
				</p>
			)}
		</>
	);
}

function QuietLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="focus-ring self-center rounded-md px-1.5 py-1.5 font-medium text-[14px] text-muted-foreground"
		>
			{children}
		</button>
	);
}

const fieldClass =
	"focus-ring w-full rounded-2xl bg-list px-4 py-3.5 text-[15px] text-foreground outline-none placeholder:text-muted-foreground";

function WorkspaceStep({
	workspace,
	firstName,
	onAddress,
	onContinue,
}: {
	workspace?: { id: string; name: string; slug: string };
	firstName?: string;
	onAddress: SetupProps["onAddress"];
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
		<form onSubmit={submit} className="flex flex-col gap-[22px]">
			<StepHeading title="Name your workspace">
				It's just you for now. You can invite people later.
			</StepHeading>
			<input
				aria-label="Workspace name"
				// biome-ignore lint/a11y/noAutofocus: the step asks one question, and this is it.
				autoFocus
				value={name}
				onChange={(event) => setName(event.target.value)}
				maxLength={64}
				placeholder={firstName ? `e.g. ${firstName}'s bots` : "e.g. Acme"}
				className={fieldClass}
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
function ModelStep({ bot, onContinue }: { bot?: Agent; onContinue: () => void }) {
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
	const [adding, setAdding] = useState(false);
	const connected = providers.filter(
		(provider) => isConnected(provider) && provider.modelCount > 0,
	);

	return (
		<div className="flex flex-col gap-[22px]">
			<StepHeading title="Connect a provider">
				Bots think with a model from a provider you already use. Pick one to start; you can add more
				later.
			</StepHeading>
			{connected.length > 0 && (
				<SettingsGroup label="Connected" headingLevel={2}>
					{connected.map((provider) => (
						<SettingsRow
							key={provider.id}
							icon={<ProviderTile name={provider.name} preset={provider.preset} />}
							label={provider.name}
							sub={`${provider.modelCount} models`}
							chevron
							onClick={() => onConnected(provider.id)}
						/>
					))}
				</SettingsGroup>
			)}
			<Button size="lg" className="w-full" onClick={() => setAdding(true)}>
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
 * connected lists, with the catalog's picks first. Only the one chosen is
 * switched on; more can be switched on later in the Models settings.
 */
function ChooseModelStep({
	provider,
	bot,
	onChosen,
	onOtherProvider,
}: {
	provider: ModelProvider;
	bot?: Agent;
	onChosen: () => void;
	onOtherProvider: () => void;
}) {
	const choose = useChooseFirstModel(bot?.id);
	// A subscription provider is added before it is signed in to, and lists its models once it is.
	const signInService = providerLacksCredential(provider)
		? presetSignInService(provider.preset)
		: undefined;
	const [search, setSearch] = useState("");
	const group = useId();
	const starters = provider.preset
		? providerPreset(provider.preset).models.map((model) => model.modelId)
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
	const large = choices.length > LARGE_CATALOG;
	const needle = search.trim().toLowerCase();
	const shown = choices.filter(
		(model) =>
			needle === "" || `${model.modelId} ${model.displayName ?? ""}`.toLowerCase().includes(needle),
	);

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
		<form onSubmit={submit} className="flex flex-col gap-[22px]">
			<StepHeading title="Choose a model">
				Your first bot thinks with this. You can switch on more of {provider.name}'s models later.
			</StepHeading>
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
							<label className="focus-ring-within flex items-center gap-[9px] rounded-xl bg-chip px-3">
								<Search aria-hidden size={15} className="shrink-0 text-muted-foreground" />
								<input
									type="search"
									value={search}
									onChange={(event) => setSearch(event.target.value)}
									placeholder={`Search ${choices.length} models`}
									aria-label="Search models"
									className="min-w-0 flex-1 bg-transparent py-[9px] text-[14px] text-foreground outline-none placeholder:text-muted-foreground"
								/>
							</label>
						</div>
					)}
					{/*
					 * A fixed height, so the centred step does not move as the search narrows the list.
					 * About four and a half rows: the cut-off one shows the list scrolls.
					 */}
					<div className={large ? "h-52 overflow-y-auto" : undefined}>
						{shown.length === 0 && (
							<p className="m-0 px-4 py-3 text-muted-foreground text-sm">No models match.</p>
						)}
						{shown.map((model) => (
							<label
								key={model.id}
								className="flex cursor-pointer items-center gap-3 border-border border-b px-4 py-3 last:border-b-0 has-focus-visible:bg-panel hover:bg-panel"
							>
								<span className="min-w-0 flex-1 truncate font-medium text-[14.5px] text-foreground">
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

function BotStep({ bot, onCreated }: { bot?: Agent; onCreated: () => void }) {
	const update = useUpdateAgent(bot?.id ?? "");
	// The Personal pod's bot starts as a placeholder; it becomes yours here.
	const started = bot && bot.name !== "Personal Assistant";
	const [color, setColor] = useState<AgentColor>(started ? bot.color : "green");
	const [face, setFace] = useState<AgentFace>(started ? bot.face : "pill");
	const [name, setName] = useState(started ? bot.name : "");
	const trimmed = name.trim();

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!bot || !trimmed) return;
		try {
			await update.mutateAsync({
				name: trimmed,
				color,
				face,
			});
		} catch {
			return;
		}
		onCreated();
	}

	return (
		<form onSubmit={submit} className="flex flex-col gap-[22px]">
			<StepHeading title="Make your first bot" />
			<div className="flex justify-center">
				<AgentAvatar color={color} face={face} size={96} />
			</div>
			<div className="overflow-hidden rounded-panel bg-list">
				<LookPicker color={color} face={face} onColorChange={setColor} onFaceChange={setFace} />
			</div>
			<input
				aria-label="Name"
				value={name}
				onChange={(event) => setName(event.target.value)}
				maxLength={64}
				placeholder="Give it a name"
				className={fieldClass}
			/>
			{!bot && <Alert>Your Personal pod has no bot to set up. Reload to try again.</Alert>}
			{update.error && <Alert>{failureMessage(update.error)}</Alert>}
			<Button
				type="submit"
				size="lg"
				className="w-full"
				disabled={!bot || !trimmed || update.isPending}
			>
				{update.isPending ? "Creating…" : "Create bot"}
			</Button>
		</form>
	);
}

/** An address as far as the invite goes: something, an @, something with a dot. */
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function InviteStep({ workspaceId, onContinue }: { workspaceId: string; onContinue: () => void }) {
	const invite = useInviteWorkspaceMember(workspaceId);
	const [emails, setEmails] = useState<string[]>([]);
	const [draft, setDraft] = useState("");
	const [failed, setFailed] = useState<{ email: string; reason: string }[]>([]);
	const [sending, setSending] = useState(false);
	const inputId = useId();

	function addDraft() {
		const typed = draft.split(/[\s,;]+/).filter((one) => LOOKS_LIKE_EMAIL.test(one));
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
		const all = [
			...new Set([
				...emails,
				...draft.split(/[\s,;]+/).filter((one) => LOOKS_LIKE_EMAIL.test(one)),
			]),
		];
		if (all.length === 0) {
			onContinue();
			return;
		}
		setSending(true);
		const failures: { email: string; reason: string }[] = [];
		for (const email of all) {
			try {
				await invite.mutateAsync({ email, role: "member" });
			} catch (error) {
				failures.push({ email, reason: failureMessage(error) });
			}
		}
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
		<form onSubmit={submit} className="flex flex-col gap-[22px]">
			<StepHeading title="Bring your friends">
				Invite people to your workspace. You can add them to pods later.
			</StepHeading>
			<div className="focus-ring-within flex min-h-[52px] flex-wrap items-center gap-1.5 rounded-2xl bg-list px-3 py-2.5">
				{emails.map((email) => (
					<span
						key={email}
						className="flex items-center gap-1.5 rounded-full bg-border-strong py-1 pr-1.5 pl-2.5 text-[13.5px]"
					>
						{email}
						<button
							type="button"
							aria-label={`Remove ${email}`}
							onClick={() => setEmails((current) => current.filter((one) => one !== email))}
							className="focus-ring grid size-[18px] place-items-center rounded-full text-soft-foreground"
						>
							<X aria-hidden size={10} strokeWidth={3} />
						</button>
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
					className="min-w-40 flex-1 bg-transparent px-1 py-1.5 text-[15px] text-foreground outline-none placeholder:text-muted-foreground"
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
						: `Send ${count} ${count === 1 ? "invite" : "invites"}`}
			</Button>
			<QuietLink onClick={onContinue}>Skip for now</QuietLink>
		</form>
	);
}

function ReadyStep({
	workspace,
	pod,
	bot,
}: {
	workspace: { id: string; slug: string };
	pod: Pod;
	bot: Agent;
}) {
	const navigate = useNavigate();
	const complete = useCompleteOnboarding();

	async function finish() {
		try {
			await complete.mutateAsync({ workspaceId: workspace.id, podId: pod.id, agentId: bot.id });
		} catch {
			return;
		}
		// Onboarding is outside any workspace, so this names one; the link helpers are for pages inside.
		await navigate({
			to: "/$workspace/pods/$pod/agents/$agent",
			params: { workspace: workspace.slug, pod: pod.slug, agent: bot.handle },
			replace: true,
		});
	}

	return (
		<>
			<StepHeading title={`${bot.name} is ready`} />
			<div
				className="flex flex-col gap-[3px] rounded-[20px] bg-list px-4 py-[18px]"
				style={botColorVariables(bot.color)}
			>
				<span className="pb-1 pl-[42px] font-medium text-[11.5px] text-muted-foreground">
					{bot.name}
				</span>
				<div className="flex items-end gap-2">
					<AgentAvatar color={bot.color} face={bot.face} size={34} />
					<div className="flex min-w-0 flex-col gap-[3px]">
						{[
							`Hi, I'm ${bot.name}.`,
							"I've only just been set up. Help me work out what I'm for?",
						].map((line) => (
							<p
								key={line}
								className="m-0 rounded-[20px_20px_20px_6px] bg-bot-tint px-3.5 py-2.5 text-[15px] text-bot-text leading-normal"
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
				Start chatting
			</Button>
		</>
	);
}

/**
 * The workspace makes each member's Personal pod as they join, so this is a
 * recovery rather than a step: making it again, on the model just connected.
 */
function PersonalPodMissing({ modelId }: { modelId?: string }) {
	const ensure = useEnsurePersonalPod();
	return (
		<>
			<StepHeading title="Your Personal pod is missing">
				It is where your first bot lives. Make it again to carry on.
			</StepHeading>
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
