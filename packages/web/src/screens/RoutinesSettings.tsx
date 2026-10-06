import type { Agent, Pod } from "@sugabots/contracts";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { useAgents } from "@/lib/agents.ts";
import { failureMessage } from "@/lib/failure.ts";
import { usePods } from "@/lib/pods.ts";
import { scheduleLabel } from "@/lib/routine-schedule.ts";
import { useRoutineActions, useRoutines, useWorkspaceRoutines } from "@/lib/routines.ts";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import {
	SettingsAddRow,
	SettingsGroup,
	SettingsPage,
	SettingsRow,
	SettingsRowIcon,
} from "@/ui/settings-page.tsx";
import { Toggle } from "@/ui/toggle.tsx";
import { type BotChoice, type PlacedRoutine, RoutineDialog } from "./RoutineDialog.tsx";

const ROUTINES_NOTE = "Routines post into the bot's chat when they run.";

/** How long Run now says Starting… at least, so a quick start doesn't flash past unread. */
const STARTING_SHOWN_MS = 1000;

/** Which routine dialog is open: a new routine, or an existing one. */
type Opened = { kind: "new" } | { kind: "edit"; placed: PlacedRoutine };

/** Every routine in the workspace the person can reach, with a way to make more. */
export function WorkspaceRoutinesSettings({ workspaceId }: { workspaceId: string }) {
	const routines = useWorkspaceRoutines(workspaceId);
	const pods = usePods();
	const { agents } = useAgents();
	const [opened, setOpened] = useState<Opened>();
	const podById = new Map(pods.data?.map((pod) => [pod.id, pod]));
	const placed = (routines.data?.items ?? []).flatMap((item): PlacedRoutine[] => {
		const pod = podById.get(item.pod.id);
		return pod ? [{ routine: item.routine, agent: item.agent, pod }] : [];
	});
	const choices = botChoices(agents ?? [], pods.data ?? []);

	return (
		<SettingsPage
			title="Routines"
			description="Things bots do on a schedule, without being asked."
			headerAction={
				choices.length > 0 && (
					<Button onClick={() => setOpened({ kind: "new" })}>New routine</Button>
				)
			}
		>
			{routines.isError ? (
				<Alert>{failureMessage(routines.error)}</Alert>
			) : routines.isPending || pods.isPending ? null : (
				<SettingsGroup label="Routines" note={placed.length > 0 ? ROUTINES_NOTE : undefined}>
					{placed.length === 0 ? (
						<SettingsRow label="No routines yet" />
					) : (
						placed.map((one) => (
							<RoutineRow
								key={one.routine.id}
								placed={one}
								showBot
								onOpen={() => setOpened({ kind: "edit", placed: one })}
							/>
						))
					)}
				</SettingsGroup>
			)}
			<RoutineDialogFor opened={opened} choices={choices} onClose={() => setOpened(undefined)} />
		</SettingsPage>
	);
}

/** One bot's routines on its card, where a new routine is made for that bot. */
export function AgentRoutines({ agent, pod }: { agent: Agent; pod: Pod }) {
	const routines = useRoutines(agent.id);
	const [opened, setOpened] = useState<Opened>();
	const canManage = pod.permissions.manageRoutines;
	const list = routines.data ?? [];
	if (routines.isPending || (list.length === 0 && !canManage)) return null;

	return (
		<SettingsGroup label="Routines" note={list.length > 0 ? ROUTINES_NOTE : undefined}>
			{routines.isError && (
				<div className="border-border border-b px-4 py-3">
					<Alert>{failureMessage(routines.error)}</Alert>
				</div>
			)}
			{list.map((routine) => {
				const placed = { routine, agent, pod };
				return (
					<RoutineRow
						key={routine.id}
						placed={placed}
						showBot={false}
						onOpen={() => setOpened({ kind: "edit", placed })}
					/>
				);
			})}
			{canManage && (
				<SettingsAddRow label="New routine" onClick={() => setOpened({ kind: "new" })} />
			)}
			<RoutineDialogFor
				opened={opened}
				choices={[{ agent, pod }]}
				onClose={() => setOpened(undefined)}
			/>
		</SettingsGroup>
	);
}

/** The crew bots a person may add a routine to, grouped by pod as the pods are listed. */
function botChoices(agents: readonly Agent[], pods: readonly Pod[]): BotChoice[] {
	return pods
		.filter((pod) => pod.permissions.manageRoutines)
		.flatMap((pod) =>
			agents
				.filter((agent) => agent.podId === pod.id && agent.systemAgentKey === null)
				.map((agent) => ({ agent, pod })),
		);
}

function RoutineDialogFor({
	opened,
	choices,
	onClose,
}: {
	opened: Opened | undefined;
	choices: readonly BotChoice[];
	onClose: () => void;
}) {
	return (
		<Dialog open={opened !== undefined} onOpenChange={(open) => !open && onClose()}>
			{opened && (
				<RoutineDialog
					key={opened.kind === "edit" ? opened.placed.routine.id : "new"}
					editing={opened.kind === "edit" ? opened.placed : undefined}
					choices={choices}
					onClose={onClose}
				/>
			)}
		</Dialog>
	);
}

/**
 * A routine's row: what it is and when it runs, a way to run it now, and
 * whether it is on. The row opens the routine; Run now and the switch beside
 * it are their own controls, so they are not inside the row's button. A paused
 * routine can still be run now: pausing stops only its schedule or webhook.
 */
function RoutineRow({
	placed,
	showBot,
	onOpen,
}: {
	placed: PlacedRoutine;
	/** Names the bot after the schedule, where the list spans more than one. */
	showBot: boolean;
	onOpen: () => void;
}) {
	const { routine, agent, pod } = placed;
	const canManage = pod.permissions.manageRoutines;
	const actions = useRoutineActions();
	const [starting, setStarting] = useState(false);
	const error = actions.update.error ?? actions.run.error;
	const summary = showBot ? `${scheduleLabel(routine)}, ${agent.name}` : scheduleLabel(routine);
	const details = (
		<>
			<SettingsRowIcon>
				<RefreshCw size={14} strokeWidth={2.4} />
			</SettingsRowIcon>
			<span className="flex min-w-0 flex-1 flex-col gap-px">
				<span className="truncate font-medium text-[14.5px] text-foreground">{routine.name}</span>
				<span className="truncate text-muted-foreground text-sm">{summary}</span>
			</span>
		</>
	);

	async function runNow() {
		setStarting(true);
		try {
			await Promise.all([
				actions.run.mutateAsync({ agentId: agent.id, routineId: routine.id }),
				new Promise((resolve) => setTimeout(resolve, STARTING_SHOWN_MS)),
			]);
		} catch {
			// The row shows the run's error.
		} finally {
			setStarting(false);
		}
	}

	return (
		<div className="flex min-w-0 flex-col border-border border-b last:border-b-0">
			<div className="flex min-w-0 items-center gap-3 px-4 py-3">
				{canManage ? (
					<button
						type="button"
						onClick={onOpen}
						className="focus-ring -my-1 -ml-1 flex min-w-0 flex-1 items-center gap-3 rounded-lg py-1 pl-1 text-left"
					>
						{details}
					</button>
				) : (
					<span className="flex min-w-0 flex-1 items-center gap-3">{details}</span>
				)}
				{pod.permissions.runRoutines && (
					<Button
						variant="link"
						size="bare"
						className="text-[13.5px]"
						aria-label={`Run ${routine.name} now`}
						disabled={starting}
						onClick={() => void runNow()}
					>
						{starting ? "Starting…" : "Run now"}
					</Button>
				)}
				<Toggle
					label={`${routine.name} on`}
					checked={routine.state === "enabled"}
					disabled={!canManage || actions.update.isPending}
					onChange={(on) =>
						actions.update.mutate({
							agentId: agent.id,
							routineId: routine.id,
							json: { state: on ? "enabled" : "paused" },
						})
					}
				/>
			</div>
			{error && (
				<div className="px-4 pb-3">
					<Alert>{failureMessage(error)}</Alert>
				</div>
			)}
		</div>
	);
}
