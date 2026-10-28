import type { ListedRoutine, Pod, Routine } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { ChevronLeft, Plus, RefreshCcw } from "lucide-react";
import type { ReactNode } from "react";
import { useAgents } from "@/lib/agents.ts";
import { useChatList } from "@/lib/chats.ts";
import { botPageLink, newRoutineLink, podLink, routineThreadLink } from "@/lib/links.ts";
import { scheduleLabel } from "@/lib/routine-schedule.ts";
import { useRecentRuns, useWorkspaceRoutines } from "@/lib/routines.ts";
import { useWorkspace } from "@/lib/workspace.ts";
import { outcomeOf, RunStatus } from "@/screens/RoutineRun.tsx";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { ListTime, Page, PageHeader } from "@/shell/Page.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { IconButton } from "@/ui/icon-button.tsx";

/**
 * A bot's routines down the left, the bot whose routine is chosen, each with
 * how it stands, and the one chosen beside them as `children`: its own
 * thread, where its runs post. On a phone the list is the page until one is chosen. With no
 * routines, the page says how one is made.
 */
export function RoutinesPage({
	pod,
	selectedRoutineId,
	botHandle,
	children,
}: {
	pod: Pod;
	selectedRoutineId: string | undefined;
	/** The bot whose routines these are, by its handle, when none of them is open. */
	botHandle?: string;
	children: ReactNode;
}) {
	const list = useChatList(pod.slug);
	const { workspace } = useWorkspace();
	const full = useWorkspaceRoutines(workspace?.id);
	const routineById = new Map(full.data?.items.map((item) => [item.routine.id, item.routine]));
	const all = list.data?.routines ?? [];
	const { agents } = useAgents();
	// The page is one bot's: the bot that runs the routine open, or the one it was opened for.
	const bot =
		all.find((row) => row.routine.id === selectedRoutineId)?.agent ??
		(botHandle === undefined
			? undefined
			: agents?.find((agent) => agent.podId === pod.id && agent.handle === botHandle));
	const routines = bot ? all.filter((row) => row.agent.id === bot.id) : all;
	const title = bot ? `${bot.name}'s routines` : "Routines";
	const chosen = selectedRoutineId !== undefined;
	const newRoutine = pod.permissions.manageRoutines && (
		<IconButton label="New routine" variant="bar" render={<Link {...newRoutineLink(bot)} />}>
			<Plus size={15} strokeWidth={2} />
		</IconButton>
	);
	// A phone reaches a bot's routines from its page, and a pod's from the pod.
	const back = (
		<IconButton
			label={`Back to ${bot ? bot.name : pod.name}`}
			variant="glass"
			render={bot ? <Link {...botPageLink(pod, bot)} /> : <Link {...podLink(pod)} />}
		>
			<ChevronLeft aria-hidden size={18} strokeWidth={2.25} />
		</IconButton>
	);
	if (list.isSuccess && routines.length === 0) {
		return (
			<Page title={title} actions={newRoutine} back={back}>
				<div className="flex h-full pb-[10%]">
					<EmptyState
						title={bot ? `No routines for ${bot.name} yet` : `No routines in ${pod.name} yet`}
						icon={<RefreshCcw strokeWidth={1.75} />}
					>
						Ask {bot ? bot.name : "a bot"} to do something on a schedule and it sets one up. Each
						routine gets its own thread for its runs.
					</EmptyState>
				</div>
			</Page>
		);
	}
	return (
		<div className="flex min-h-0 min-w-0 flex-1">
			<section
				aria-label="Routines"
				className={cn(
					"flex min-h-0 flex-col border-border border-r max-md:flex-1 md:w-[220px] lg:w-[280px]",
					chosen && "max-md:hidden",
				)}
			>
				<PageHeader title={title} actions={newRoutine} back={back} />
				<ul className="m-0 flex min-h-0 flex-1 list-none flex-col gap-0.5 overflow-y-auto p-2">
					{list.isError && (
						<li className="px-2.5 py-2 text-[13px] text-muted-foreground">
							Routines could not be loaded.
						</li>
					)}
					{routines.map((row) => (
						<li key={row.routine.id}>
							<RoutineRow
								pod={pod}
								row={row}
								routine={routineById.get(row.routine.id)}
								selected={row.routine.id === selectedRoutineId}
							/>
						</li>
					))}
				</ul>
			</section>
			<div className={cn("flex min-w-0 flex-1 flex-col", !chosen && "max-md:hidden")}>
				{children}
			</div>
		</div>
	);
}

/**
 * A routine: the bot that runs it, its name, when it last ran, and under it
 * how it stands: paused, or how its last run went, or when it runs before it
 * has. A paused one is greyer; one whose thread mentions the viewer is bright.
 */
function RoutineRow({
	pod,
	row,
	routine,
	selected,
}: {
	pod: Pod;
	row: ListedRoutine;
	/** The routine in full, for when it runs, once the workspace's routines are loaded. */
	routine: Routine | undefined;
	selected: boolean;
}) {
	const lastRun = useRecentRuns({ agentId: row.agent.id, routineId: row.routine.id }).data
		?.items[0];
	const paused = row.routine.state === "paused";
	return (
		<Link
			{...routineThreadLink(pod, row.routine.id)}
			aria-current={selected ? "page" : undefined}
			className={cn(
				"focus-ring flex gap-2.5 rounded-lg p-2.5 transition-colors",
				selected ? "bg-row-selected" : "hover:bg-row-hover",
			)}
		>
			<AgentAvatar
				color={row.agent.color}
				face={row.agent.face}
				shape={row.agent.shape}
				size={20}
				className={cn("shrink-0", paused && "opacity-50")}
			/>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="flex min-w-0 items-baseline gap-2">
					<span
						className={cn(
							"min-w-0 flex-1 truncate-fade text-[13px]",
							selected || row.mentionsYou
								? "text-foreground"
								: paused
									? "text-subtle-foreground"
									: "text-muted-foreground",
							row.mentionsYou && "font-semibold",
						)}
					>
						{row.routine.name}
						{row.mentionsYou && <span className="sr-only">, mentions you</span>}
					</span>
					{lastRun && <ListTime at={lastRun.acceptedAt} />}
				</span>
				{paused ? (
					<RunStatus outcome="paused" />
				) : lastRun ? (
					<RunStatus outcome={outcomeOf(lastRun.state)} />
				) : (
					<span className="truncate text-subtle-foreground text-xs">
						{(routine && scheduleLabel(routine)) ?? "Not run yet"}
					</span>
				)}
			</span>
		</Link>
	);
}
