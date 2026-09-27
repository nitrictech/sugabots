import { botColorVariables } from "@sugabots/avatars";
import {
	type Agent,
	type AgentColor,
	type AgentFace,
	type ModelProvider,
	type Pod,
	type ProviderPresetId,
	providerPreset,
	slugify,
} from "@sugabots/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronLeft, X } from "lucide-react";
import { type FormEvent, type KeyboardEvent, type ReactNode, useId, useState } from "react";
import { useAgents, useModels, useUpdateAgent } from "@/lib/agents.ts";
import { failureMessage } from "@/lib/failure.ts";
import { useModelProviders } from "@/lib/model-providers.ts";
import { useCompleteOnboarding, useConnectFirstModel } from "@/lib/onboarding.ts";
import { useEnsurePersonalPod, usePods } from "@/lib/pods.ts";
import { parseProviderBaseUrl } from "@/lib/provider-url.ts";
import type { Session } from "@/lib/session.ts";
import {
	useCreateWorkspace,
	useInviteWorkspaceMember,
	useUpdateWorkspace,
	useWorkspace,
} from "@/lib/workspace.ts";
import { isConnected } from "@/screens/ProviderSettings.tsx";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { ColourPicker, EyesPicker } from "@/shell/LookPickers.tsx";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { ProviderTile } from "./ProviderSettings.tsx";

/*
 * The first run: name the workspace, connect a model, make the first bot,
 * invite people, then meet the bot. Signing in comes before, on the login
 * page, which is the welcome. The first bot is the Personal pod's own, which
 * the workspace made with it, so making it here is giving it a face and a name.
 */

type Step = "workspace" | "model" | "bot" | "invite" | "ready";

/** The steps the dots count. Ready has none: there is nothing left to go back to. */
const counted: readonly Step[] = ["workspace", "model", "bot", "invite"];

export function Onboarding({ session }: { session: Session }) {
	const { workspace } = useWorkspace();
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
	// Coming back part way through picks up where the workspace says it got to.
	const inferred: Step = !workspace
		? "workspace"
		: (models.data?.models.length ?? 0) === 0
			? "model"
			: "bot";
	const step = chosen ?? inferred;
	const loading = Boolean(workspace) && (pods.isPending || models.isPending || agentsPending);
	const failure = pods.error ?? models.error ?? agentsError;
	const index = counted.indexOf(step);
	const back = index > 0 ? counted[index - 1] : undefined;

	return (
		<OnboardingFrame
			current={index === -1 ? undefined : index}
			onBack={back ? () => setChosen(back) : undefined}
		>
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
					onContinue={() => setChosen("model")}
				/>
			) : step === "model" ? (
				<ModelStep onContinue={() => setChosen("bot")} />
			) : !workspace || !personalPod ? (
				<PersonalPodMissing modelId={models.data?.models[0]?.modelId} />
			) : step === "bot" ? (
				<BotStep
					bot={firstBot}
					modelIds={models.data?.models.map((model) => model.modelId) ?? []}
					onCreated={() => setChosen("invite")}
				/>
			) : step === "invite" ? (
				<InviteStep workspaceId={workspace.id} onContinue={() => setChosen("ready")} />
			) : firstBot ? (
				<ReadyStep workspace={workspace} pod={personalPod} bot={firstBot} />
			) : null}
		</OnboardingFrame>
	);
}

function OnboardingFrame({
	current,
	onBack,
	children,
}: {
	/** Which counted step this is, for the dots; none on the last. */
	current?: number;
	onBack?: () => void;
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

function SkipLink({ onClick }: { onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="focus-ring self-center rounded-md px-1.5 py-1.5 font-medium text-[14px] text-muted-foreground"
		>
			Skip for now
		</button>
	);
}

const fieldClass =
	"focus-ring w-full rounded-2xl bg-list px-4 py-3.5 text-[15px] text-foreground outline-none placeholder:text-muted-foreground";

function WorkspaceStep({
	workspace,
	firstName,
	onContinue,
}: {
	workspace?: { id: string; name: string; slug: string };
	firstName?: string;
	onContinue: () => void;
}) {
	const create = useCreateWorkspace();
	const update = useUpdateWorkspace(workspace?.id);
	const [name, setName] = useState(workspace?.name ?? "");
	const trimmed = name.trim();
	const pending = create.isPending || update.isPending;

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!slugify(trimmed)) return;
		try {
			const input = { name: trimmed, slug: slugify(trimmed) };
			if (workspace) {
				if (trimmed !== workspace.name) await update.mutateAsync(input);
			} else {
				await create.mutateAsync(input);
			}
		} catch {
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

/** The four the design offers first; the rest are a click away in settings. */
const firstProviders: readonly { preset: ProviderPresetId; line: string }[] = [
	{ preset: "anthropic", line: "Claude models" },
	{ preset: "openai", line: "GPT models" },
	{ preset: "openrouter", line: "Hundreds of models, one key" },
	{ preset: "ollama", line: "Runs on your own machine" },
];

const KEY_PLACEHOLDERS: Partial<Record<ProviderPresetId, string>> = {
	anthropic: "sk-ant-…",
	openai: "sk-…",
	openrouter: "sk-or-…",
};

function ModelStep({ onContinue }: { onContinue: () => void }) {
	const providers = useModelProviders();
	const connect = useConnectFirstModel();
	const [chosen, setChosen] = useState<ProviderPresetId>("anthropic");
	const [secret, setSecret] = useState("");
	const group = useId();
	const fieldId = useId();
	const preset = providerPreset(chosen);
	const local = preset.hosting === "local";
	const existing = providers.data?.find((provider) => provider.preset === chosen);
	const alreadyConnected =
		existing !== undefined && isConnected(existing) && existing.enabledModelCount > 0;
	const baseUrl = local ? parseProviderBaseUrl(secret || preset.baseUrl) : undefined;
	const ready = alreadyConnected || (local ? baseUrl !== undefined : secret.trim() !== "");

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!ready) return;
		if (alreadyConnected && !secret) {
			onContinue();
			return;
		}
		try {
			await connect.mutateAsync({
				preset,
				existing: existing as ModelProvider | undefined,
				apiKey: local ? undefined : secret.trim(),
				baseUrl,
			});
		} catch {
			return;
		}
		onContinue();
	}

	return (
		<form onSubmit={submit} className="flex flex-col gap-[22px]">
			<StepHeading title="Connect a model">
				Bots think with a model from a provider you already use. Pick one to start; you can add more
				later.
			</StepHeading>
			<fieldset className="m-0 overflow-hidden rounded-panel border-0 bg-list p-0">
				<legend className="sr-only">Provider</legend>
				{firstProviders.map(({ preset: id, line }) => {
					const name = providerPreset(id).name;
					return (
						<label
							key={id}
							className="flex cursor-pointer items-center gap-3 border-border border-b px-4 py-3 last:border-b-0 has-focus-visible:bg-panel hover:bg-panel"
						>
							<ProviderTile name={name} preset={id} />
							<span className="flex min-w-0 flex-1 flex-col gap-px">
								<span className="font-medium text-[14.5px] text-foreground">{name}</span>
								<span className="text-muted-foreground text-sm">{line}</span>
							</span>
							<input
								type="radio"
								name={group}
								checked={chosen === id}
								onChange={() => {
									setChosen(id);
									setSecret("");
								}}
								className="size-5 shrink-0 accent-primary"
							/>
						</label>
					);
				})}
			</fieldset>
			<div className="flex items-center gap-3 rounded-2xl bg-list px-4 py-3.5">
				<label htmlFor={fieldId} className="w-[70px] shrink-0 text-[14px] text-muted-foreground">
					{local ? "Address" : "API key"}
				</label>
				<input
					id={fieldId}
					type={local ? "text" : "password"}
					autoComplete="off"
					value={secret}
					onChange={(event) => setSecret(event.target.value)}
					placeholder={
						alreadyConnected
							? "Connected"
							: local
								? "localhost:11434"
								: (KEY_PLACEHOLDERS[chosen] ?? "Paste your key")
					}
					className="min-w-0 flex-1 bg-transparent font-mono text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground"
				/>
			</div>
			{connect.error && <Alert>{failureMessage(connect.error)}</Alert>}
			<Button type="submit" size="lg" className="w-full" disabled={!ready || connect.isPending}>
				{connect.isPending ? "Connecting…" : "Continue"}
			</Button>
			<SkipLink onClick={onContinue} />
		</form>
	);
}

/** What the first bot can be for, each with what it says when it first says hello. */
const purposes = [
	{
		label: "Inbox",
		description: "Sorts your email and flags what needs you.",
		intro: "I'll sort your email and flag what needs you.",
		ask: "Want me to go through what came in overnight?",
	},
	{
		label: "Research",
		description: "Digs into anything you're curious about and sums it up.",
		intro: "I'll dig into anything you're curious about and sum it up.",
		ask: "What's on your mind? I'll put a short brief together.",
	},
	{
		label: "Planning",
		description: "Keeps your calendar, trips and plans in order.",
		intro: "I'll keep your calendar, trips and plans in order.",
		ask: "Anything coming up this week I should help with?",
	},
	{
		label: "Reminders",
		description: "Keeps track of the things you'd rather not remember.",
		intro: "I'll keep track of the things you'd rather not remember.",
		ask: "What should I remind you about first?",
	},
	{
		label: "Something else",
		description: undefined,
		intro: "",
		ask: "Tell me what you need help with.",
	},
] as const;

type Purpose = (typeof purposes)[number];

function purposeOf(bot: Agent | undefined): Purpose | undefined {
	return purposes.find((purpose) => purpose.description === bot?.description);
}

function BotStep({
	bot,
	modelIds,
	onCreated,
}: {
	bot?: Agent;
	/** The models switched on, the first of which the bot moves to if its own is not one. */
	modelIds: readonly string[];
	onCreated: () => void;
}) {
	const update = useUpdateAgent(bot?.id ?? "");
	// The Personal pod's bot starts as a placeholder; it becomes yours here.
	const started = bot && bot.name !== "Personal Assistant";
	const [color, setColor] = useState<AgentColor>(started ? bot.color : "green");
	const [face, setFace] = useState<AgentFace>(started ? bot.face : "pill");
	const [name, setName] = useState(started ? bot.name : "");
	const [purpose, setPurpose] = useState<Purpose | undefined>(purposeOf(bot));
	const group = useId();
	const trimmed = name.trim();

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!bot || !trimmed) return;
		try {
			await update.mutateAsync({
				name: trimmed,
				color,
				face,
				description: purpose?.description ?? null,
				...(modelIds[0] && !modelIds.includes(bot.model ?? "") ? { model: modelIds[0] } : {}),
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
				<div className="flex items-center gap-3 border-border border-b px-4 py-3 max-md:flex-col max-md:items-start">
					<span className="w-14 shrink-0 text-[14px] text-muted-foreground">Colour</span>
					<ColourPicker value={color} onChange={setColor} />
				</div>
				<div className="flex items-center gap-3 px-4 py-2.5 max-md:flex-col max-md:items-start">
					<span className="w-14 shrink-0 text-[14px] text-muted-foreground">Eyes</span>
					<EyesPicker color={color} value={face} onChange={setFace} variant="chips" />
				</div>
			</div>
			<input
				aria-label="Name"
				value={name}
				onChange={(event) => setName(event.target.value)}
				maxLength={64}
				placeholder="Give it a name"
				className={fieldClass}
			/>
			<fieldset className="m-0 flex flex-col gap-2.5 border-0 p-0">
				<legend className="px-1 pb-2.5 font-medium text-sm text-subtle-foreground">
					What should it help with?
				</legend>
				<div className="flex flex-wrap gap-2">
					{purposes.map((one) => (
						<label
							key={one.label}
							className="cursor-pointer rounded-full bg-chip px-3.5 py-2 font-medium text-[14px] text-foreground transition-colors has-checked:bg-foreground has-checked:text-background has-focus-visible:shadow-(--ring-shadow)"
						>
							<input
								type="radio"
								name={group}
								checked={purpose?.label === one.label}
								onChange={() => setPurpose(one)}
								className="sr-only"
							/>
							{one.label}
						</label>
					))}
				</div>
			</fieldset>
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
			<SkipLink onClick={onContinue} />
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
	const purpose = purposeOf(bot);
	const hello = [`Hi, I'm ${bot.name}.`, purpose?.intro].filter(Boolean).join(" ");

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
						{[hello, purpose?.ask ?? purposes[4].ask].map((line) => (
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
