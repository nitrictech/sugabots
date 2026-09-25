import { type Agent, type Pod, slugify } from "@sugabots/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, Check, Circle } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { useAgents, useModels } from "@/lib/agents.ts";
import { failureMessage } from "@/lib/failure.ts";
import { useCompleteOnboarding } from "@/lib/onboarding.ts";
import { useEnsurePersonalPod, usePods } from "@/lib/pods.ts";
import type { Session } from "@/lib/session.ts";
import { useCreateWorkspace, useUpdateWorkspace, useWorkspace } from "@/lib/workspace.ts";
import { ModelProvidersSettings } from "@/screens/ModelProvidersSettings/index.tsx";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { Field } from "@/ui/field.tsx";
import { Input } from "@/ui/input.tsx";

type Step = "workspace" | "pod" | "provider";

const steps: Array<{ id: Step; label: string; note: string }> = [
	{ id: "workspace", label: "Workspace", note: "Your shared home" },
	{ id: "provider", label: "Model", note: "Connect intelligence" },
	{ id: "pod", label: "Personal", note: "Your private assistant" },
];

export function Onboarding({ session }: { session: Session }) {
	const workspaceQuery = useWorkspace();
	const workspace = workspaceQuery.workspace;
	const pods = usePods();
	const models = useModels(Boolean(workspace));
	const ensurePersonal = useEnsurePersonalPod();
	const {
		agents,
		isPending: agentsPending,
		error: agentsError,
		refetch: refetchAgents,
	} = useAgents();
	const [chosenStep, setChosenStep] = useState<Step>();
	const personalPod = pods.data?.find(
		(pod) => pod.kind === "personal" && pod.ownerId === session.user?.id,
	);
	const personalAssistant = agents?.find(
		(agent) => agent.podId === personalPod?.id && agent.systemAgentKey === null,
	);
	// The assistant starts on a placeholder model, and the server won't finish
	// onboarding until it runs on an enabled one; the Provider step's Continue sets it.
	const assistantModelEnabled = Boolean(
		models.data?.models.some((model) => model.modelId === personalAssistant?.model),
	);
	const inferredStep: Step = !workspace ? "workspace" : assistantModelEnabled ? "pod" : "provider";
	const step = chosenStep ?? inferredStep;
	const stepIndex = steps.findIndex((item) => item.id === step);
	const previousStep = stepIndex > 0 ? steps[stepIndex - 1]?.id : undefined;

	const loading =
		Boolean(workspace) &&
		(pods.isPending || (Boolean(pods.data?.length) && (models.isPending || agentsPending)));
	const failure = pods.error ?? models.error ?? agentsError;

	return (
		<OnboardingFrame
			step={step}
			userName={session.user?.name ?? "there"}
			onBack={previousStep ? () => setChosenStep(previousStep) : undefined}
		>
			{loading ? (
				<p className="text-muted-foreground">Loading your setup…</p>
			) : failure ? (
				<div className="space-y-4">
					<Alert>{failureMessage(failure)}</Alert>
					<Button
						variant="outline"
						onClick={() => void Promise.all([pods.refetch(), models.refetch(), refetchAgents()])}
					>
						Try again
					</Button>
				</div>
			) : step === "workspace" ? (
				<WorkspaceStep workspace={workspace} onContinue={() => setChosenStep("provider")} />
			) : step === "provider" ? (
				<ProviderStep
					ready={(models.data?.models.length ?? 0) > 0}
					onContinue={() => {
						const model = models.data?.models[0]?.modelId;
						if (!model) return;
						void ensurePersonal.mutateAsync(model).then(async () => {
							await Promise.all([pods.refetch(), refetchAgents()]);
							setChosenStep("pod");
						});
					}}
				/>
			) : workspace && personalAssistant ? (
				<PodStep workspace={workspace} agent={personalAssistant} existingPod={personalPod} />
			) : null}
		</OnboardingFrame>
	);
}

function OnboardingFrame({
	step,
	userName,
	onBack,
	children,
}: {
	step: Step;
	userName: string;
	onBack?: () => void;
	children: ReactNode;
}) {
	const active = steps.findIndex((one) => one.id === step);
	return (
		<main className="min-h-screen overflow-auto bg-background p-3 text-foreground sm:p-5">
			<div className="grid min-h-[calc(100vh-1.5rem)] w-full lg:min-h-[calc(100vh-2.5rem)] lg:grid-cols-[17rem_1fr] lg:gap-3">
				<aside className="relative overflow-hidden px-4 py-4 sm:px-6 lg:px-7 lg:py-6">
					<div className="relative flex h-full flex-col">
						<div className="flex items-center gap-2.5">
							<AgentAvatar hue={151} face="bar" size={28} />
							<span className="font-semibold text-heading text-lg">Sugabots</span>
						</div>

						<div className="mt-10 hidden lg:block">
							<p className="font-semibold text-heading text-lg">Hey, {userName.split(" ")[0]}.</p>
							<p className="mt-2 max-w-48 text-muted-foreground text-sm leading-relaxed">
								Let’s set up your workspace and introduce your first agent.
							</p>
						</div>

						<ol className="mt-5 grid grid-cols-4 gap-1 lg:mt-10 lg:flex lg:flex-col lg:gap-0">
							{steps.map((item, index) => {
								const complete = index < active;
								const current = index === active;
								return (
									<li key={item.id} className="relative flex min-w-0 gap-3 pb-0 lg:pb-9">
										{index < steps.length - 1 && (
											<span className="absolute top-3 left-3 hidden h-full w-px bg-border lg:block" />
										)}
										<span
											className={`relative z-10 grid size-6 shrink-0 place-items-center rounded-full border text-2xs ${
												complete || current
													? "border-primary bg-primary text-primary-foreground"
													: "border-border bg-background text-muted-foreground"
											}`}
										>
											{complete ? <Check size={13} /> : current ? index + 1 : <Circle size={7} />}
										</span>
										<div className="min-w-0 pt-0.5">
											<p
												className={`truncate font-medium text-sm ${current ? "text-heading" : ""}`}
											>
												{item.label}
											</p>
											<p className="hidden text-muted-foreground text-xs lg:block">{item.note}</p>
										</div>
									</li>
								);
							})}
						</ol>
					</div>
				</aside>

				<section className="flex min-w-0 items-start rounded-2xl border border-border-subtle bg-card px-6 py-12 shadow-[var(--shadow-card)] sm:px-10 lg:px-[clamp(3rem,7vw,7rem)] lg:py-[clamp(5rem,12vh,8rem)]">
					<div className="w-full">
						{onBack && (
							<Button variant="ghost" size="sm" className="mb-7 -ml-2" onClick={onBack}>
								<ArrowLeft size={15} /> Back
							</Button>
						)}
						{children}
					</div>
				</section>
			</div>
		</main>
	);
}

function StepHeading({ title, children }: { title: string; children: ReactNode }) {
	return (
		<header className="mb-8 max-w-xl">
			<h1 className="font-semibold text-3xl text-heading leading-[1.1] sm:text-4xl">{title}</h1>
			<p className="mt-4 text-base text-muted-foreground leading-relaxed">{children}</p>
		</header>
	);
}

function WorkspaceStep({
	workspace,
	onContinue,
}: {
	workspace?: { id: string; name: string; slug: string };
	onContinue: () => void;
}) {
	const create = useCreateWorkspace();
	const update = useUpdateWorkspace(workspace?.id);
	const [name, setName] = useState(workspace?.name ?? "");
	const trimmed = name.trim();
	async function submit(event: FormEvent) {
		event.preventDefault();
		try {
			const input = { name: trimmed, slug: slugify(trimmed) };
			if (workspace) {
				await update.mutateAsync(input);
			} else {
				await create.mutateAsync(input);
			}
			onContinue();
		} catch {}
	}
	return (
		<>
			<StepHeading title="Name the place where work happens.">
				Workspaces hold your people, pods, model connections, and shared agents.
			</StepHeading>
			<div className="max-w-lg">
				<form onSubmit={submit} className="space-y-5">
					<Field id="onboarding-workspace" label="Workspace name">
						<Input
							id="onboarding-workspace"
							autoFocus
							value={name}
							onChange={(e) => setName(e.target.value)}
							maxLength={64}
							placeholder="Acme product"
						/>
					</Field>
					{trimmed && (
						<p className="font-mono text-muted-foreground text-xs">sugabots / {slugify(trimmed)}</p>
					)}
					{(create.error || update.error) && (
						<Alert>
							{failureMessage(create.error ?? update.error, {
								Conflict: "That workspace address is already taken.",
							})}
						</Alert>
					)}
					<Button
						type="submit"
						disabled={!slugify(trimmed) || create.isPending || update.isPending}
					>
						{create.isPending || update.isPending ? "Saving workspace…" : "Continue"}{" "}
						<ArrowRight size={16} />
					</Button>
				</form>
			</div>
		</>
	);
}

function ProviderStep({ ready, onContinue }: { ready: boolean; onContinue: () => void }) {
	return (
		<>
			<StepHeading title="Bring your own model.">
				Agents turn on your provider account, with your key. Connect one, then enable the models
				your team may use.
			</StepHeading>
			<div className="overflow-hidden rounded-xl border border-border-subtle">
				<ModelProvidersSettings className="h-[720px]" detailScrollable={false} />
			</div>
			<div className="mt-8 flex items-center justify-between gap-4 border-border-subtle border-t pt-5">
				<p className="text-muted-foreground text-sm">
					{ready ? "Your model is ready." : "Enable one model to continue."}
				</p>
				<Button disabled={!ready} onClick={onContinue}>
					Continue <ArrowRight size={16} />
				</Button>
			</div>
		</>
	);
}

function PodStep({
	workspace,
	agent,
	existingPod,
}: {
	workspace: { id: string; slug: string };
	agent: Agent;
	existingPod?: Pod;
}) {
	const navigate = useNavigate();
	const complete = useCompleteOnboarding();

	async function finish(pod: Pod) {
		await complete.mutateAsync({ workspaceId: workspace.id, podId: pod.id, agentId: agent.id });
		// Onboarding is outside any workspace, so this names one; the link helpers are for pages inside.
		await navigate({
			to: "/$workspace/pods/$pod/agents/$agent",
			params: { workspace: workspace.slug, pod: pod.slug, agent: agent.handle },
			replace: true,
		});
	}

	return (
		<>
			<StepHeading title="Your Personal pod is ready.">Your assistant lives here.</StepHeading>
			{existingPod ? (
				<Button onClick={() => void finish(existingPod)} disabled={complete.isPending}>
					Enter {existingPod.name} <ArrowRight size={16} />
				</Button>
			) : (
				<Alert>Your Personal pod could not be loaded.</Alert>
			)}
		</>
	);
}
