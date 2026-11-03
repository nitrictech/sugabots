import type { Agent, Pod } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { Plus, RefreshCcw } from "lucide-react";
import { useChatList } from "@/lib/chats.ts";
import { newRoutineLink } from "@/lib/links.ts";
import { useWorkspaceRoutines } from "@/lib/routines.ts";
import { useWorkspace } from "@/lib/workspace.ts";
import { RoutineRow } from "@/shell/Routines.tsx";
import { Stage, StageMark } from "@/shell/Stage.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { IconButton } from "@/ui/icon-button.tsx";

/**
 * A bot's routines, open large beside its chat as its computer is, each
 * opening its own thread, with + to make another for whoever may manage them.
 * With none, it says how one is made.
 */
export function RoutinesStage({
	agent,
	pod,
	onClose,
}: {
	agent: Agent;
	pod: Pod;
	onClose: () => void;
}) {
	const list = useChatList(pod.slug);
	const { workspace } = useWorkspace();
	const full = useWorkspaceRoutines(workspace?.id);
	const routineById = new Map(full.data?.items.map((item) => [item.routine.id, item.routine]));
	const routines = list.data?.routines.filter((row) => row.agent.id === agent.id) ?? [];
	const title = `${agent.name}'s routines`;
	return (
		<Stage
			label={title}
			icon={
				<StageMark>
					<RefreshCcw strokeWidth={2} />
				</StageMark>
			}
			title={title}
			actions={
				pod.permissions.manageRoutines && (
					<IconButton
						label="New routine"
						variant="bar"
						render={<Link {...newRoutineLink(pod, agent)} />}
					>
						<Plus size={16} strokeWidth={1.75} />
					</IconButton>
				)
			}
			onClose={onClose}
		>
			{list.isError ? (
				<EmptyState title="Could not load these routines">
					The API did not answer. Reload this page to try again.
				</EmptyState>
			) : list.isSuccess && routines.length === 0 ? (
				<EmptyState
					title={`No routines for ${agent.name} yet`}
					icon={<RefreshCcw strokeWidth={1.75} />}
				>
					Ask {agent.name} to set some up for you.
				</EmptyState>
			) : (
				<ul className="m-0 flex min-h-0 flex-1 list-none flex-col gap-0.5 overflow-y-auto p-0">
					{routines.map((row) => (
						<li key={row.routine.id}>
							<RoutineRow
								pod={pod}
								row={row}
								routine={routineById.get(row.routine.id)}
								selected={false}
							/>
						</li>
					))}
				</ul>
			)}
		</Stage>
	);
}
