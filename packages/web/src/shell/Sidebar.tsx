import type { Agent, Pod } from "@sugabots/contracts";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { cn } from "cn";
import { Ellipsis, Plus, Settings } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { findPodAgent, useAgents } from "@/lib/agents.ts";
import { agentChatLink, agentSettingsLink, podSettingsLink } from "@/lib/links.ts";
import { useFoldedPods } from "@/lib/pod-folding.ts";
import { findPod, usePods } from "@/lib/pods.ts";
import { useWorkspace, useWorkspacePermissions } from "@/lib/workspace.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { NewAgentDialog } from "@/shell/NewAgent.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuLinkItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { ScrollArea } from "@/ui/scroll-area.tsx";
import { Sidebar as Rail, SidebarRow, SidebarSection } from "@/ui/sidebar.tsx";
import { PodSandboxChip } from "./PodSandboxChip.tsx";

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
	return (
		<Rail aria-label="Workspace" className="min-h-0 flex-1">
			<AgentRoster onNavigate={onNavigate} />
		</Rail>
	);
}

/**
 * The agents in this workspace, under the pods they work in.
 *
 * Shared pods scroll. The Personal pod does not: it sits at the foot, against
 * the account it belongs to, and the shared pods pass under it — so the pod
 * that is always yours is always in reach. It folds like any other pod, since
 * where it lives and how much room it takes are separate questions.
 */
function AgentRoster({ onNavigate }: { onNavigate?: () => void }) {
	const selected = useParams({ strict: false });
	const { data: pods, isPending: podsPending, error: podsError } = usePods();
	const { agents, isPending: agentsPending, error: agentsError } = useAgents();
	const may = useWorkspacePermissions();
	const { workspace } = useWorkspace();
	const { isFolded, toggle, unfold } = useFoldedPods(workspace?.id);

	const isPending = podsPending || agentsPending;
	const error = podsError ?? agentsError;
	const visibleAgents = agents?.filter((agent) => agent.systemAgentKey === null) ?? [];
	// A settings page names a pod without an agent; that still opens the pod.
	const selectedPodId = selected.pod === undefined ? undefined : findPod(pods, selected.pod)?.id;
	const selectedAgentId =
		selected.pod === undefined || selected.agent === undefined
			? undefined
			: findPodAgent(pods, agents, selected.pod, selected.agent)?.agent.id;
	const personalPod = pods?.find((pod) => pod.kind === "personal");
	const sharedPods = pods?.filter((pod) => pod.kind === "shared") ?? [];

	// Arriving at an agent opens the pod holding it, so a link into a folded pod
	// does not land on a rail with nothing in it. Only on arrival, though:
	// folding the pod you are reading is a thing people do, and an unfold that
	// fired on every render would undo it as fast as they asked for it.
	const opened = useRef<string>(undefined);
	useEffect(() => {
		if (selectedPodId === undefined || selectedPodId === opened.current) return;
		opened.current = selectedPodId;
		unfold(selectedPodId);
	}, [selectedPodId, unfold]);

	const renderPod = (pod: Pod, { capped = false } = {}) => (
		<PodSection
			key={pod.id}
			pod={pod}
			agents={visibleAgents.filter((agent) => agent.podId === pod.id)}
			selectedAgentId={selectedAgentId}
			open={!isFolded(pod.id)}
			onToggle={() => toggle(pod.id)}
			capped={capped}
			onNavigate={onNavigate}
		/>
	);

	return (
		<>
			<ScrollArea className="min-h-0 flex-1">
				{error ? (
					<p className="px-2.5 py-3 text-base text-muted-foreground">Could not load your agents.</p>
				) : isPending ? (
					// Nothing rather than a spinner: this is one local request, and a
					// skeleton that flashes for 40ms reads as a fault.
					<div className="h-8" />
				) : pods?.length === 0 ? (
					<p className="px-2.5 pt-3 pb-1 text-base text-muted-foreground">
						{may.createPods ? "No pods yet." : "You are not in a pod yet."}
					</p>
				) : null}

				{sharedPods.map((pod) => renderPod(pod))}
			</ScrollArea>

			{personalPod && (
				<div className="shrink-0 border-sidebar-border border-t">
					{renderPod(personalPod, { capped: true })}
				</div>
			)}
		</>
	);
}

/**
 * One pod in the rail, and everything that makes an agent in it: the heading's
 * plus, the same item in its menu, and the row an empty pod offers in place of
 * nothing at all. One piece of state between them, so all three open the same
 * form and there is only ever one of it.
 */
function PodSection({
	pod,
	agents,
	selectedAgentId,
	open,
	onToggle,
	capped = false,
	onNavigate,
}: {
	pod: Pod;
	agents: Agent[];
	selectedAgentId: string | undefined;
	open: boolean;
	onToggle: () => void;
	/** The pinned Personal pod, which may not take the whole rail. */
	capped?: boolean;
	onNavigate?: () => void;
}) {
	const [creating, setCreating] = useState(false);
	const navigate = useNavigate();

	function body() {
		if (agents.length === 0) {
			if (!pod.permissions.createAgents) {
				return <p className="px-2.5 pt-1 pb-2 text-base text-muted-foreground">No agents yet.</p>;
			}
			return <NewAgentRow onClick={() => setCreating(true)} />;
		}
		const rows = agents.map((agent) => (
			<AgentRow
				key={`${pod.id}:${agent.id}`}
				agent={agent}
				pod={pod}
				selected={agent.id === selectedAgentId}
				onNavigate={onNavigate}
			/>
		));
		// Folding is the cheaper way out of a long Personal pod, but somebody who
		// keeps it open still gets to see the pods above it.
		return capped ? <div className="max-h-[32vh] overflow-y-auto">{rows}</div> : rows;
	}

	return (
		<>
			<SidebarSection
				label={pod.name}
				open={open}
				onToggle={onToggle}
				count={agents.length}
				status={<PodSandboxChip podId={pod.id} />}
				actions={<PodActions pod={pod} onNew={() => setCreating(true)} onNavigate={onNavigate} />}
			>
				{body()}
			</SidebarSection>

			<Dialog open={creating} onOpenChange={setCreating}>
				<NewAgentDialog
					podId={pod.id}
					onCreated={async (agent) => {
						setCreating(false);
						onNavigate?.();
						await navigate(agentSettingsLink({ pod, agent }));
					}}
				/>
			</Dialog>
		</>
	);
}

/**
 * What an empty pod offers instead of a blank space under its heading: the row
 * from the design, dashed where a face would be. The heading's plus is still up
 * there, but a pod with nothing in it is exactly where somebody is looking for
 * the way to put something in it.
 */
function NewAgentRow({ onClick }: { onClick: () => void }) {
	return (
		<SidebarRow
			as="button"
			type="button"
			onClick={onClick}
			className="min-h-11 w-full gap-2.5 rounded-xl px-2.5 py-1.5 text-left"
		>
			<span className="grid size-7 shrink-0 place-items-center rounded-full border border-control-border border-dashed text-subtle-foreground">
				<Plus size={14} />
			</span>
			<span className="min-w-0 flex-1 font-medium text-base text-muted-foreground">New agent</span>
		</SidebarRow>
	);
}

/**
 * What a pod's heading offers.
 *
 * The plus is what people came for and the ellipsis holds the rest, both drawn
 * at rest rather than waiting for a hover that a touchscreen never sends. New
 * agent appears in both, the way a section menu repeats its own primary action.
 *
 * A control the pod's permissions do not allow is not drawn, so a Personal pod
 * — nobody to invite, nothing to rename — carries the plus alone.
 */
function PodActions({
	pod,
	onNew,
	onNavigate,
}: {
	pod: Pod;
	onNew: () => void;
	onNavigate?: () => void;
}) {
	const mayCreate = pod.permissions.createAgents;
	const maySettle = pod.permissions.rename || pod.permissions.manageMembers;

	if (!mayCreate && !maySettle) return null;

	return (
		<>
			{mayCreate && (
				<IconButton label={`New agent in ${pod.name}`} size="lg" onClick={onNew}>
					<Plus />
				</IconButton>
			)}

			{maySettle && (
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<IconButton label={`${pod.name} actions`} size="lg">
								<Ellipsis />
							</IconButton>
						}
					/>
					<DropdownMenuContent align="end" className="min-w-52">
						<DropdownMenuGroup>
							<DropdownMenuLabel className="text-subtle-foreground">{pod.name}</DropdownMenuLabel>
							{mayCreate && (
								<DropdownMenuItem onClick={onNew}>
									<Plus />
									New agent
								</DropdownMenuItem>
							)}
						</DropdownMenuGroup>
						<DropdownMenuSeparator />
						<DropdownMenuLinkItem render={<Link {...podSettingsLink(pod)} />} onClick={onNavigate}>
							<Settings />
							Pod settings
						</DropdownMenuLinkItem>
					</DropdownMenuContent>
				</DropdownMenu>
			)}
		</>
	);
}

function AgentRow({
	agent,
	pod,
	selected,
	onNavigate,
}: {
	agent: Agent;
	pod: Pod;
	selected: boolean;
	onNavigate?: () => void;
}) {
	const content = (
		<>
			<AgentAvatar hue={agent.hue} face={agent.face} size={28} />
			<span
				className={cn(
					"min-w-0 flex-1 truncate text-base",
					selected ? "font-semibold text-heading" : "font-medium text-sidebar-muted-foreground",
				)}
			>
				{agent.name}
			</span>
		</>
	);

	return (
		<SidebarRow
			as={Link}
			{...agentChatLink({ pod, agent })}
			selected={selected}
			aria-current={selected ? "page" : undefined}
			onClick={onNavigate}
			// Denser than a settings row: a workspace with six pods in it has to
			// fit on the screen before anybody scrolls.
			className="min-h-11 gap-2.5 rounded-xl px-2.5 py-1.5"
		>
			{content}
		</SidebarRow>
	);
}
