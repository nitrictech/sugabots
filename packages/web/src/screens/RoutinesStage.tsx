import type { Agent, Pod, SessionUser } from "@sugabots/contracts";
import { Plus, RefreshCcw, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useChatList, useOpenRoutineFeed } from "@/lib/chats.ts";
import { usePanelKeys } from "@/lib/panel-keys.ts";
import { useWorkspaceRoutines } from "@/lib/routines.ts";
import { useWorkspace } from "@/lib/workspace.ts";
import { NoRoutines, RoutineRow } from "@/shell/Routines.tsx";
import { Stage, StageMark, type StageParent } from "@/shell/Stage.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { ConversationChat, type StagedChange } from "./ConversationChat.tsx";
import { NewRoutinePage } from "./RoutineEditor.tsx";

interface RoutinesStageProps {
	agent: Agent;
	pod: Pod;
	user: SessionUser;
	view: RoutinesView;
	onViewChange: (view: RoutinesView) => void;
	/** Opens something else beside the bot's chat, such as an artifact from a routine's thread. */
	onStagedChange: StagedChange;
	onClose: () => void;
}

/** Which of a bot's routines are open beside its chat: all of them, one, or a new one being made. */
export type RoutinesView =
	| { kind: "list" }
	| { kind: "routine"; routineId: string }
	| { kind: "new" };

/**
 * A bot's routines, open large beside its chat as its computer is: all of
 * them, each opening its own thread in their place, or a new one being made.
 * A routine or a new one is a level inside the list, and the Back before its
 * name returns to the list, so the bot's chat stays in view throughout.
 * Escape goes back up a level at a time, as the Back does, then closes it.
 */
export function RoutinesStage({
	agent,
	pod,
	user,
	view,
	onViewChange,
	onStagedChange,
	onClose,
}: RoutinesStageProps) {
	const title = `${agent.name}'s routines`;
	const parent = { name: title, onBack: () => onViewChange({ kind: "list" }) };
	if (view.kind === "routine") {
		return (
			<RoutineThread
				key={view.routineId}
				pod={pod}
				agent={agent}
				user={user}
				routineId={view.routineId}
				onStagedChange={onStagedChange}
				parent={parent}
				trailing={<CloseButton onClose={onClose} />}
			/>
		);
	}
	const mark = (
		<StageMark>
			<RefreshCcw strokeWidth={2} />
		</StageMark>
	);
	if (view.kind === "new") {
		return (
			<Stage
				key="new"
				label="New routine"
				icon={mark}
				title="New routine"
				parent={parent}
				onClose={onClose}
			>
				<div className="-mx-6 min-h-0 flex-1 overflow-y-auto max-md:-mx-3">
					<NewRoutinePage
						choices={[{ agent, pod }]}
						initialAgentId={agent.id}
						onCancel={() => onViewChange({ kind: "list" })}
						onCreated={(routine) => onViewChange({ kind: "routine", routineId: routine.id })}
					/>
				</div>
			</Stage>
		);
	}
	return (
		<Stage
			// Its own, apart from a new one's, so each takes the focus as it opens.
			key="list"
			label={title}
			icon={mark}
			title={title}
			actions={
				pod.permissions.manageRoutines && (
					<IconButton
						label="New routine"
						variant="bar"
						onClick={() => onViewChange({ kind: "new" })}
					>
						<Plus size={16} strokeWidth={1.75} />
					</IconButton>
				)
			}
			onClose={onClose}
		>
			<RoutineList
				agent={agent}
				pod={pod}
				onOpen={(routineId) => onViewChange({ kind: "routine", routineId })}
				onNew={() => onViewChange({ kind: "new" })}
			/>
		</Stage>
	);
}

/** The bot's routines, each with how it stands, which opens it; with none, how one is made. */
function RoutineList({
	agent,
	pod,
	onOpen,
	onNew,
}: {
	agent: Agent;
	pod: Pod;
	onOpen: (routineId: string) => void;
	onNew: () => void;
}) {
	const list = useChatList(pod.slug);
	const { workspace } = useWorkspace();
	const full = useWorkspaceRoutines(workspace?.id);
	const routineById = new Map(full.data?.items.map((item) => [item.routine.id, item.routine]));
	const routines = list.data?.routines.filter((row) => row.agent.id === agent.id) ?? [];
	if (list.isError) {
		return (
			<EmptyState title="Could not load these routines">
				The API did not answer. Reload this page to try again.
			</EmptyState>
		);
	}
	if (list.isSuccess && routines.length === 0) {
		return (
			<NoRoutines
				title={`No routines for ${agent.name} yet`}
				pod={pod}
				create={
					pod.permissions.manageRoutines
						? {
								newRoutine: <button type="button" onClick={onNew} />,
								// Not linked: the bot's chat is already open beside this panel.
								whoToAsk: agent.name,
							}
						: undefined
				}
			/>
		);
	}
	return (
		<ul className="m-0 flex min-h-0 flex-1 list-none flex-col gap-0.5 overflow-y-auto p-0">
			{routines.map((row) => (
				<li key={row.routine.id}>
					<RoutineRow
						pod={pod}
						row={row}
						routine={routineById.get(row.routine.id)}
						selected={false}
						render={<button type="button" onClick={() => onOpen(row.routine.id)} />}
					/>
				</li>
			))}
		</ul>
	);
}

/**
 * A routine's own thread, where its runs post, opened first when it has none,
 * with its settings in its Details, Back to `parent` before its name, and
 * `trailing` at the right of its header.
 */
function RoutineThread({
	pod,
	agent,
	user,
	routineId,
	onStagedChange,
	parent,
	trailing,
}: {
	pod: Pod;
	agent: Agent;
	user: SessionUser;
	routineId: string;
	onStagedChange: StagedChange;
	/** The bot's routines, which the Back before the routine's name returns to. */
	parent: StageParent;
	trailing: ReactNode;
}) {
	const opened = useOpenRoutineFeed(pod, routineId);
	const keys = usePanelKeys<HTMLElement>(parent.onBack);
	const [threadId, setThreadId] = useState<string>();
	const [detailsOpen, setDetailsOpen] = useState(false);
	return (
		// In place of the list, and like it, covering the chat on a phone; there
		// while its thread opens, so it holds the focus from the start.
		<section
			aria-label="Routine"
			{...keys}
			className="flex min-h-0 min-w-0 flex-1 bg-background outline-none max-md:absolute max-md:inset-0 max-md:z-40"
		>
			{opened.isError ? (
				<EmptyState title="Could not open this routine">
					It may have been removed. Reload this page to try again.
				</EmptyState>
			) : (
				opened.data && (
					<ConversationChat
						conversation={{ kind: "botThread", agent }}
						pod={pod}
						conversationId={opened.data.id}
						user={user}
						threadId={threadId}
						onThreadChange={setThreadId}
						place={{ kind: "own", detailsOpen, onDetailsChange: setDetailsOpen, parent, trailing }}
						onStagedChange={onStagedChange}
					/>
				)
			)}
		</section>
	);
}

/** Closes the routines, as a stage's Close does. */
function CloseButton({ onClose }: { onClose: () => void }) {
	return (
		<IconButton label="Close" variant="bar" onClick={onClose} className="max-md:hidden">
			<X size={16} strokeWidth={1.75} />
		</IconButton>
	);
}
