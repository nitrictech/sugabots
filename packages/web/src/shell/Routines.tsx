import { useRender } from "@base-ui/react/use-render";
import type { ListedRoutine, Pod, Routine } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { Plus, RefreshCcw } from "lucide-react";
import type { ReactNode } from "react";
import { useAgents } from "@/lib/agents.ts";
import { useChatList } from "@/lib/chats.ts";
import { agentChatLink, newRoutineLink, routineThreadLink } from "@/lib/links.ts";
import { SIDE_BY_SIDE, useMediaQuery } from "@/lib/media.ts";
import { scheduleLabel } from "@/lib/routine-schedule.ts";
import { useRecentRuns, useWorkspaceRoutines } from "@/lib/routines.ts";
import { useWorkspace } from "@/lib/workspace.ts";
import { outcomeOf, RunStatus } from "@/screens/RoutineRun.tsx";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { ListTime, PageHeader } from "@/shell/Page.tsx";
import { buttonStyles } from "@/ui/button.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { FLOATING_ON_PHONE, IconButton } from "@/ui/icon-button.tsx";

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
	making = false,
	children,
}: {
	pod: Pod;
	selectedRoutineId: string | undefined;
	/** The bot whose routines these are, by its handle, when none of them is open. */
	botHandle?: string;
	/** Whether a routine is being made beside the list, which on a phone covers it as an open one does. */
	making?: boolean;
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
	const chosen = selectedRoutineId !== undefined || making;
	const newRoutine = pod.permissions.manageRoutines && (
		<IconButton
			label="New routine"
			variant="bar"
			// A link, so it says it is the page open rather than pressed.
			aria-current={making ? "page" : undefined}
			render={<Link {...newRoutineLink(pod, bot)} />}
			className={cn(
				"aria-[current=page]:bg-chip aria-[current=page]:text-foreground",
				FLOATING_ON_PHONE,
			)}
		>
			<Plus size={16} strokeWidth={1.75} />
		</IconButton>
	);
	// With none yet, the list stays, with its + where it always is, and the space beside it says how one is made.
	const none = list.isSuccess && routines.length === 0;
	// A phone has no space beside the list, so the list's own says so.
	const phone = !useMediaQuery(SIDE_BY_SIDE);
	const noneYet = (
		<div className="flex h-full pb-20">
			<NoRoutines
				title={bot ? `No routines for ${bot.name} yet` : `No routines in ${pod.name} yet`}
				pod={pod}
				create={
					pod.permissions.manageRoutines
						? {
								newRoutine: <Link {...newRoutineLink(pod, bot)} />,
								whoToAsk: bot ? (
									<Link
										{...agentChatLink({ pod, agent: bot })}
										className="focus-ring rounded-sm text-link underline"
									>
										{bot.name}
									</Link>
								) : (
									"a bot"
								),
							}
						: undefined
				}
			/>
		</div>
	);
	return (
		<div className="flex min-h-0 min-w-0 flex-1">
			<section
				aria-label="Routines"
				className={cn(
					// `min-w-0`: a long bot's name in the title is cut short rather than widening the page.
					"flex min-h-0 min-w-0 flex-col border-border border-r max-md:flex-1 md:w-70 md:shrink-0",
					chosen && "max-md:hidden",
				)}
			>
				<PageHeader title={title} place={{ kind: "pod", pod }} actions={newRoutine} />
				{none && phone && !chosen && <div className="flex min-h-0 flex-1 flex-col">{noneYet}</div>}
				<ul
					className={cn(
						"tab-bar-clearance m-0 flex min-h-0 flex-1 list-none flex-col gap-0.5 overflow-y-auto p-2",
						none && phone && "hidden",
					)}
				>
					{list.isError && (
						<li className="px-2.5 py-2 text-xs text-muted-foreground">
							Routines could not be loaded.
						</li>
					)}
					{none && !phone && (
						// Quiet and in the middle, as Inbox's empty list is; the way to make one is in the space beside it.
						<li className="m-auto px-6 py-16 text-center text-xs text-muted-foreground">
							No routines yet
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
				{none && !chosen && !phone ? noneYet : children}
			</div>
		</div>
	);
}

/**
 * No routines yet, and how one is made: for someone who may make one, New
 * routine, with asking a bot instead under it. Anyone else is sent to whoever
 * manages the pod's routines, as a bot makes them only for someone who may.
 */
export function NoRoutines({
	title,
	pod,
	create,
}: {
	title: string;
	pod: Pick<Pod, "name">;
	/** For a viewer who may manage the pod's routines; omitted for anyone else. */
	create?: {
		/** The element New routine is, such as a link to the form or a button that opens it. */
		newRoutine: useRender.RenderProp;
		/** Who could set one up instead, such as the bot, linked to its chat. */
		whoToAsk: ReactNode;
	};
}) {
	const newRoutine = useRender({
		enabled: create !== undefined,
		render: create?.newRoutine,
		props: { className: buttonStyles({ size: "sm" }), children: "New routine" },
	});
	return (
		<EmptyState title={title} icon={<RefreshCcw strokeWidth={1.75} />}>
			{create ? (
				<span className="mt-3 flex flex-col items-center gap-3">
					{newRoutine}
					<span>Or ask {create.whoToAsk} to set one up.</span>
				</span>
			) : (
				<>Ask someone who manages {pod.name}'s routines to set one up.</>
			)}
		</EmptyState>
	);
}

/**
 * A routine: the bot that runs it, its name, when it last ran, and under it
 * how it stands: paused, or how its last run went, or when it runs before it
 * has. A paused one is greyer; one whose thread mentions the viewer is bright.
 * It opens the routine's own thread, or does what `render` does instead.
 */
export function RoutineRow({
	pod,
	row,
	routine,
	selected,
	render,
}: {
	pod: Pod;
	row: ListedRoutine;
	/** The routine in full, for when it runs, once the workspace's routines are loaded. */
	routine: Routine | undefined;
	selected: boolean;
	/** The element the row is, such as a button that opens the routine where the list is. */
	render?: useRender.RenderProp;
}) {
	const lastRun = useRecentRuns({ agentId: row.agent.id, routineId: row.routine.id }).data
		?.items[0];
	const paused = row.routine.state === "paused";
	return useRender({
		render: render ?? <Link {...routineThreadLink(pod, row.routine.id)} />,
		props: {
			"aria-current": selected ? "page" : undefined,
			className: cn(
				"focus-ring flex w-full gap-2.5 rounded-lg p-2.5 text-left transition-colors",
				selected ? "bg-row-selected" : "hover:bg-row-hover",
			),
			children: (
				<>
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
									"min-w-0 flex-1 truncate-fade text-xs",
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
				</>
			),
		},
	});
}
