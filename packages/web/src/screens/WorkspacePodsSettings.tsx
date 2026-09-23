import {
	type Agent,
	hueFromText,
	type Pod,
	type PodMember,
	type PodPermissions,
	type PodRouting,
	type PodUpdate,
	workspaceRoleLabel,
	workspaceRoleOf,
} from "@sugabots/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Bot, Ellipsis, LockKeyhole, Plus, User } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { useAgents, useDeleteAgent } from "@/lib/agents.ts";
import { isSetUp, useBuiltInAgent } from "@/lib/built-in-agents.ts";
import { failureMessage } from "@/lib/failure.ts";
import {
	useDeletePod,
	usePlacePodMember,
	usePodMembers,
	usePods,
	useUpdatePod,
} from "@/lib/pods.ts";
import { useWorkspaceMembers } from "@/lib/workspace.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { NewAgentButton } from "@/shell/NewAgent.tsx";
import { NewPodButton } from "@/shell/NewPod.tsx";
import { Alert } from "@/ui/alert.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";
import { Button } from "@/ui/button.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { Input } from "@/ui/input.tsx";
import { SettingsRail, SettingsRailItem, SettingsSplitView } from "@/ui/settings-rail.tsx";
import { StatusDot } from "@/ui/status-dot.tsx";
import { Tab, TabPanel, Tabs, TabsList } from "@/ui/tabs.tsx";
import { AgentSettingsPage } from "./AgentSettingsPage.tsx";
import {
	AN_ADMINISTRATOR_CHOOSES,
	BuiltInAgentLink,
	useCanConfigureBuiltInAgents,
} from "./BuiltInAgentSetup.tsx";
import { ConnectionsSettings } from "./ConnectionsSettings.tsx";

export function WorkspacePodsSettings({
	selectedPodId,
	selectedAgentId,
	selectedAgentTab,
	canCreatePods,
}: {
	selectedPodId?: string;
	selectedAgentId?: string;
	selectedAgentTab?: "routines";
	canCreatePods: boolean;
}) {
	const { data: pods, isPending, error } = usePods();
	const { agents } = useAgents();
	const personalPod = pods?.find((pod) => pod.kind === "personal");
	const sharedPods = pods?.filter((pod) => pod.kind === "shared") ?? [];
	const selected =
		selectedPodId === undefined
			? (personalPod ?? sharedPods[0])
			: pods?.find((pod) => pod.id === selectedPodId);
	const missing = selectedPodId !== undefined && !isPending && !selected;
	const selectedAgent = agents?.find(
		(agent) => agent.id === selectedAgentId && agent.podId === selected?.id,
	);
	const selectedPodAgents = agents?.filter((agent) => agent.podId === selected?.id) ?? [];
	const podRailItem = (pod: Pod) => (
		<SettingsRailItem
			key={pod.id}
			selected={pod.id === selected?.id}
			render={<Link to="/settings/pods/$pod" params={{ pod: pod.id }} />}
		>
			<PodMark pod={pod} />
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="truncate text-base font-medium text-foreground">{pod.name}</span>
				{pod.kind === "personal" ? (
					<span className="flex items-center gap-0.5 text-muted-foreground text-xs">
						{agents?.filter((agent) => agent.podId === pod.id).length ?? 0}
						<Bot aria-hidden size={11} />
						<span className="sr-only">agents</span>
					</span>
				) : (
					<PodCounts
						pod={pod}
						agents={agents?.filter((agent) => agent.podId === pod.id).length ?? 0}
					/>
				)}
			</span>
		</SettingsRailItem>
	);
	const agentRailItem = (agent: Agent) => (
		<SettingsRailItem
			key={agent.id}
			selected={agent.id === selectedAgentId}
			render={
				<Link
					to="/settings/pods/$pod/agents/$agent"
					params={{ pod: agent.podId, agent: agent.id }}
				/>
			}
		>
			<AgentAvatar hue={agent.hue} face={agent.face} size={28} />
			<span className="min-w-0 flex-1 truncate text-base font-medium text-foreground">
				{agent.name}
			</span>
			<StatusDot
				on={agent.model !== null}
				label={agent.model !== null ? "Set up" : "Not set up"}
				tooltip={agent.model !== null ? `Runs on ${agent.model}` : "Not set up: choose a model"}
			/>
		</SettingsRailItem>
	);

	return (
		<SettingsSplitView
			showDetail={selectedPodId !== undefined || selectedAgentId !== undefined}
			rail={
				selectedAgentId && selected ? (
					<SettingsRail
						label={`${selected.name} agents`}
						footer={
							selected.permissions.createAgents ? (
								<NewAgentButton
									podId={selected.id}
									variant="secondary"
									className="h-11 w-full justify-center border-dashed text-base"
								/>
							) : undefined
						}
					>
						<Link
							to="/settings/$section"
							params={{ section: "pods" }}
							className="focus-ring mx-2 mb-3 flex items-center gap-2 rounded-lg px-2 py-2 font-medium text-muted-foreground text-sm hover:bg-sidebar-accent hover:text-foreground"
						>
							<ArrowLeft aria-hidden size={16} />
							<span>Back to pods</span>
						</Link>
						{selectedPodAgents.map(agentRailItem)}
					</SettingsRail>
				) : (
					<SettingsRail
						label="Workspace pods"
						footer={
							canCreatePods ? (
								<NewPodButton
									variant="secondary"
									className="h-11 w-full justify-center border-dashed text-base"
								/>
							) : undefined
						}
					>
						{personalPod && (
							<p className="px-3 pt-1 pb-1 font-semibold text-muted-foreground text-xs uppercase tracking-wider">
								Personal
							</p>
						)}
						{personalPod && podRailItem(personalPod)}
						{sharedPods.length > 0 && (
							<p className="px-3 pt-5 pb-1 font-semibold text-muted-foreground text-xs uppercase tracking-wider">
								Pods
							</p>
						)}
						{sharedPods.map(podRailItem)}
						{error && <Alert className="px-3 py-2">{failureMessage(error)}</Alert>}
					</SettingsRail>
				)
			}
			detail={
				selected && selectedAgent ? (
					<AgentSettingsPage
						key={`${selectedAgent.id}:${selectedAgentTab ?? "details"}`}
						agent={selectedAgent}
						pod={selected}
						initialTab={selectedAgentTab}
					/>
				) : selectedAgentId ? (
					<EmptyState title="No such agent in this pod" />
				) : selected ? (
					<PodDetails key={selected.id} pod={selected} />
				) : missing ? (
					<EmptyState title="No such pod here">
						It may have been removed, or you may no longer have access to it.
					</EmptyState>
				) : !isPending && pods?.length === 0 ? (
					<EmptyState title="No pods yet">
						{canCreatePods
							? "Create the first pod for this workspace."
							: "You are not in a pod yet."}
					</EmptyState>
				) : null
			}
		/>
	);
}

function PodMark({ pod, large = false }: { pod: Pod; large?: boolean }) {
	if (pod.kind === "personal") {
		return (
			<span
				aria-hidden
				className={`grid shrink-0 place-items-center rounded-lg bg-primary-tint text-primary ${large ? "size-11" : "size-9"}`}
			>
				<LockKeyhole size={large ? 20 : 16} strokeWidth={2} />
			</span>
		);
	}
	return (
		<span
			aria-hidden
			className={`agent-tint grid shrink-0 place-items-center rounded-lg bg-agent-fill font-semibold text-agent-ink ${large ? "size-11 text-xl" : "size-9 text-base"}`}
			style={{ ["--agent-hue" as string]: hueFromText(pod.slug) }}
		>
			{pod.name.trim().charAt(0).toUpperCase() || "?"}
		</span>
	);
}

function PodCounts({ pod, agents }: { pod: Pod; agents: number }) {
	const members = usePodMembers(pod.id);
	return (
		<span className="flex items-center gap-2.5 text-muted-foreground text-xs">
			<span className="flex items-center gap-0.5">
				{members.data?.length ?? "–"}
				<User aria-hidden size={11} />
				<span className="sr-only">people</span>
			</span>
			<span className="flex items-center gap-0.5">
				{agents}
				<Bot aria-hidden size={11} />
				<span className="sr-only">agents</span>
			</span>
		</span>
	);
}

function PodDetails({ pod }: { pod: Pod }) {
	const may = pod.permissions;
	const update = useUpdatePod(pod.id);
	const [renaming, setRenaming] = useState(false);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const remove = useDeletePod();
	const navigate = useNavigate();

	async function deletePod() {
		try {
			await remove.mutateAsync(pod.id);
		} catch {
			return;
		}
		await navigate({ to: "/settings/$section", params: { section: "pods" } });
	}

	return (
		<div className="w-full max-w-[720px] px-5 py-6 sm:px-8 sm:py-7">
			<header className="flex flex-col gap-4">
				<div className="flex items-center gap-4">
					<IconButton
						label="Back to pods"
						className="lg:hidden"
						render={<Link to="/settings/$section" params={{ section: "pods" }} />}
					>
						<ArrowLeft />
					</IconButton>
					<PodMark pod={pod} large />
					{renaming ? (
						<RenameForm
							pod={pod}
							save={update.mutateAsync}
							savePending={update.isPending}
							done={() => setRenaming(false)}
						/>
					) : (
						<div className="min-w-0 flex-1">
							<h2 className="m-0 truncate font-display text-2xl font-semibold text-heading">
								{pod.name}
							</h2>
						</div>
					)}
					{may.rename && !renaming && (
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<IconButton label={`${pod.name} options`} variant="outline" size="lg">
										<Ellipsis />
									</IconButton>
								}
							/>
							<DropdownMenuContent align="end" className="min-w-44">
								<DropdownMenuItem onClick={() => setRenaming(true)}>Rename</DropdownMenuItem>
								{pod.kind === "shared" && (
									<>
										<DropdownMenuSeparator />
										<DropdownMenuItem
											variant="destructive"
											onClick={() => setConfirmingDelete(true)}
										>
											Delete pod
										</DropdownMenuItem>
									</>
								)}
							</DropdownMenuContent>
						</DropdownMenu>
					)}
				</div>
				<DeleteDialog
					open={confirmingDelete}
					onOpenChange={setConfirmingDelete}
					title={`Delete ${pod.name}?`}
					description="Its agents and conversations will be permanently deleted."
					pending={remove.isPending}
					error={remove.error ? failureMessage(remove.error) : undefined}
					onDelete={deletePod}
				/>
				{update.error && <Alert>{failureMessage(update.error)}</Alert>}
			</header>

			<Tabs defaultValue="members" className="pt-7">
				<TabsList>
					<Tab value="members">{pod.kind === "personal" ? "Personal" : "Team"}</Tab>
					<Tab value="connections">Connections</Tab>
					<Tab value="routing">Routing</Tab>
				</TabsList>
				<TabPanel value="members" className="flex flex-col gap-7">
					{pod.kind === "personal" ? (
						<Section
							label="Private pod"
							description="Only you can access this pod, its agents, and its conversations."
						/>
					) : (
						<Members pod={pod} canManageMembers={may.manageMembers} />
					)}
					<PodAgents pod={pod} may={may} />
				</TabPanel>
				<TabPanel value="connections">
					<ConnectionsSettings podId={pod.id} canManage={may.manageConnections} />
				</TabPanel>
				<TabPanel value="routing">
					<Routing
						pod={pod}
						disabled={!may.changeRouting || update.isPending}
						save={(routing) => update.mutate({ routing })}
					/>
				</TabPanel>
			</Tabs>
		</div>
	);
}

function RenameForm({
	pod,
	save,
	savePending,
	done,
}: {
	pod: Pod;
	save: (change: PodUpdate) => Promise<unknown>;
	savePending: boolean;
	done: () => void;
}) {
	const [draft, setDraft] = useState(pod.name);
	const id = useId();
	const name = draft.trim();

	async function rename() {
		try {
			await save({ name });
		} catch {
			return;
		}
		done();
	}

	return (
		<form
			className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
			onSubmit={(event) => {
				event.preventDefault();
				void rename();
			}}
		>
			<label htmlFor={id} className="sr-only">
				Name
			</label>
			<Input
				id={id}
				value={draft}
				onChange={(event) => setDraft(event.target.value)}
				className="min-w-40 flex-1 font-display text-lg font-semibold"
				maxLength={64}
				required
				disabled={savePending}
			/>
			<Button type="submit" size="sm" disabled={savePending || name === "" || name === pod.name}>
				Save name
			</Button>
			<Button type="button" size="sm" variant="outline" onClick={done} disabled={savePending}>
				Cancel
			</Button>
		</form>
	);
}

function Section({
	label,
	action,
	description,
	children,
}: {
	label: string;
	action?: ReactNode;
	description?: string;
	children?: ReactNode;
}) {
	return (
		<section className="flex flex-col gap-2.5">
			<div className="flex flex-col gap-0.5">
				<div className="flex items-baseline justify-between gap-3">
					<h3 className="m-0 font-semibold text-md text-heading">{label}</h3>
					{action}
				</div>
				{description !== undefined && (
					<p className="m-0 text-md text-muted-foreground">{description}</p>
				)}
			</div>
			{children !== undefined && children}
		</section>
	);
}

function Card({ children }: { children: ReactNode }) {
	return (
		<ul className="m-0 flex list-none flex-col divide-y divide-border-subtle overflow-hidden rounded-xl border border-border-subtle bg-card p-0">
			{children}
		</ul>
	);
}

function RemoveButton({
	label,
	...props
}: {
	label: string;
	disabled: boolean;
	onClick: () => void;
}) {
	return (
		<Button
			variant="ghost"
			size="sm"
			aria-label={label}
			className="text-muted-foreground hover:text-destructive"
			{...props}
		>
			Remove
		</Button>
	);
}

/*
 * The people who can see into the pod. Anyone in the workspace can be added;
 * the label after a name is their standing in the workspace, since a pod has
 * no roles of its own.
 */
function Members({ pod, canManageMembers }: { pod: Pod; canManageMembers: boolean }) {
	const members = usePodMembers(pod.id);
	const workspaceMembers = useWorkspaceMembers(pod.workspaceId);
	const place = usePlacePodMember(pod.id);
	const inPod = new Set(members.data?.map((member) => member.userId));
	const roleOf = (userId: string) =>
		workspaceMembers.data?.find((member) => member.userId === userId)?.role;
	const roleLabel = (userId: string) => workspaceRoleLabel(workspaceRoleOf(roleOf(userId)));
	const invitable = workspaceMembers.data?.filter((member) => !inPod.has(member.userId)) ?? [];

	return (
		<Section
			label="Members"
			action={
				canManageMembers && (
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<IconButton label="Invite" size="lg" disabled={place.isPending}>
									<Plus />
								</IconButton>
							}
						/>
						<DropdownMenuContent align="end" className="min-w-52">
							{workspaceMembers.isPending ? (
								<DropdownMenuItem disabled>Loading…</DropdownMenuItem>
							) : invitable.length === 0 ? (
								<DropdownMenuItem disabled>Everyone in the workspace is here.</DropdownMenuItem>
							) : (
								invitable.map((member) => (
									<DropdownMenuItem
										key={member.userId}
										onClick={() => place.mutate({ userId: member.userId, member: true })}
									>
										{/* Hidden from the name, or the initials would read as part of it. */}
										<span aria-hidden>
											<PersonAvatar
												name={member.user.name}
												email={member.user.email}
												image={member.user.image}
												size={22}
											/>
										</span>
										<span className="min-w-0 flex-1 truncate">{member.user.name}</span>
									</DropdownMenuItem>
								))
							)}
						</DropdownMenuContent>
					</DropdownMenu>
				)
			}
		>
			{members.isError ? (
				<Alert>{failureMessage(members.error)}</Alert>
			) : members.data?.length === 0 ? (
				<p className="m-0 text-base text-subtle-foreground">Nobody can see into this pod yet.</p>
			) : (
				<Card>
					{members.data?.map((member: PodMember) => (
						<li key={member.userId} className="flex min-h-12 items-center gap-3 px-3.5 py-2">
							<PersonAvatar
								name={member.name}
								email={member.email}
								image={member.image}
								size={28}
							/>
							<span className="min-w-0 flex-1 truncate font-medium text-base text-heading">
								{member.name}
							</span>
							<span className="text-muted-foreground text-sm">{roleLabel(member.userId)}</span>
							{canManageMembers && (
								<RemoveButton
									label={`Remove ${member.name}`}
									disabled={place.isPending}
									onClick={() => place.mutate({ userId: member.userId, member: false })}
								/>
							)}
						</li>
					))}
				</Card>
			)}
			{place.error && <Alert>{failureMessage(place.error)}</Alert>}
		</Section>
	);
}

function PodAgents({ pod, may }: { pod: Pod; may: PodPermissions }) {
	const { agents } = useAgents();
	const remove = useDeleteAgent();
	const [deletingAgent, setDeletingAgent] = useState<Agent>();
	const inPod = agents?.filter((agent) => agent.podId === pod.id) ?? [];
	const row = (agent: Agent) => (
		<li key={agent.id} className="flex min-h-12 items-center gap-3 px-3.5 py-2">
			<AgentAvatar hue={agent.hue} face={agent.face} size={28} />
			<Link
				to="/settings/pods/$pod/agents/$agent"
				params={{ pod: pod.id, agent: agent.id }}
				className="focus-ring min-w-0 flex-1 truncate rounded-sm font-medium text-base text-heading hover:underline"
			>
				{agent.name}
			</Link>
			{may.deleteAgents && (
				<Button
					variant="ghost"
					size="sm"
					disabled={remove.isPending}
					onClick={() => setDeletingAgent(agent)}
				>
					Delete
				</Button>
			)}
		</li>
	);

	return (
		<>
			<Section
				label="Agents"
				action={may.createAgents && <NewAgentButton podId={pod.id} iconOnly />}
			>
				{inPod.length === 0 ? (
					<p className="m-0 text-base text-subtle-foreground">No agents in this pod yet.</p>
				) : (
					<Card>{inPod.map(row)}</Card>
				)}
			</Section>
			<DeleteDialog
				open={deletingAgent !== undefined}
				onOpenChange={(open) => {
					if (!open) setDeletingAgent(undefined);
				}}
				title={`Delete ${deletingAgent?.name ?? "agent"}?`}
				description="This can't be undone."
				pending={remove.isPending}
				error={remove.error ? failureMessage(remove.error) : undefined}
				onDelete={async () => {
					if (!deletingAgent) return;
					try {
						await remove.mutateAsync(deletingAgent.id);
						setDeletingAgent(undefined);
					} catch {
						return;
					}
				}}
			/>
		</>
	);
}

type RoutingChoice = "nobody" | "facilitator";

const ROUTING: Record<RoutingChoice, PodRouting> = {
	nobody: { facilitator: false },
	facilitator: { facilitator: true },
};

function routingChoice(routing: PodRouting): RoutingChoice {
	return routing.facilitator ? "facilitator" : "nobody";
}

function Routing({
	pod,
	disabled,
	save,
}: {
	pod: Pod;
	disabled: boolean;
	save: (routing: PodRouting) => void;
}) {
	const { agent: facilitator } = useBuiltInAgent("facilitate");
	const ready = isSetUp(facilitator);
	const mayConfigure = useCanConfigureBuiltInAgents();
	const chosen = routingChoice(pod.routing);
	const group = useId();

	return (
		<Section
			label="Automated threads"
			description="Choose whether the Facilitator routes non-chat threads. Direct chats respond only through the selected agent or an explicit @mention."
		>
			<div
				className="flex flex-col gap-2.5"
				role="radiogroup"
				aria-label="Automated thread routing"
			>
				<RoutingOption
					group={group}
					value="nobody"
					chosen={chosen}
					disabled={disabled}
					onChoose={(choice) => save(ROUTING[choice])}
					title="Nobody"
					detail="Automated threads stay with their current agent. Quietest option."
				/>
				<RoutingOption
					group={group}
					value="facilitator"
					chosen={chosen}
					// The Facilitator runs on a model the workspace chooses once. Until
					// somebody has, there is nothing to hand the floor to, and the API
					// refuses this for the same reason.
					disabled={disabled || !ready}
					onChoose={(choice) => save(ROUTING[choice])}
					title="The Facilitator decides"
					detail={
						<>
							Reads the last few messages and picks who answers, or nobody.{" "}
							{ready ? (
								<>
									Uses <code className="text-foreground">{facilitator?.model}</code>
									{mayConfigure && (
										<>
											, <BuiltInAgentLink agentKey="facilitate">change</BuiltInAgentLink>
										</>
									)}
									.
								</>
							) : mayConfigure ? (
								<>
									The Facilitator has no model yet —{" "}
									<BuiltInAgentLink agentKey="facilitate">set it up</BuiltInAgentLink> to use this.
								</>
							) : (
								<>The Facilitator has no model yet. {AN_ADMINISTRATOR_CHOOSES}</>
							)}
						</>
					}
				/>
			</div>
			{chosen === "facilitator" && !ready && (
				<Alert>
					Facilitator routing is on, but the Facilitator has no model, so automated threads are
					staying with their current agent.
				</Alert>
			)}
		</Section>
	);
}

function RoutingOption({
	group,
	value,
	chosen,
	disabled,
	onChoose,
	title,
	detail,
}: {
	group: string;
	value: RoutingChoice;
	chosen: RoutingChoice;
	disabled: boolean;
	onChoose: (choice: RoutingChoice) => void;
	title: string;
	detail: ReactNode;
}) {
	const titleId = useId();
	const detailId = useId();
	const selected = value === chosen;
	// A disabled radio is not focusable, so what says why is the description —
	// and the link inside it, which stays reachable by keyboard. The card must
	// stop offering itself too: hover lighting up reads as clickable.
	const appearance = [
		selected ? "border-primary-tint-border bg-primary-tint/40" : "border-border-subtle bg-card",
		disabled ? "opacity-60" : selected ? "cursor-pointer" : "cursor-pointer hover:bg-muted",
	].join(" ");
	return (
		<label
			className={`flex items-start gap-3 rounded-xl border px-4 py-3 transition-colors ${appearance}`}
		>
			<input
				type="radio"
				name={group}
				value={value}
				checked={selected}
				disabled={disabled}
				aria-labelledby={titleId}
				aria-describedby={detailId}
				onChange={() => onChoose(value)}
				className="mt-1 size-4 shrink-0 accent-primary"
			/>
			<span className="flex min-w-0 flex-col gap-0.5">
				<span id={titleId} className="font-medium text-base text-heading">
					{title}
				</span>
				<span id={detailId} className="text-md text-muted-foreground">
					{detail}
				</span>
			</span>
		</label>
	);
}
