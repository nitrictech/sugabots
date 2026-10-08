import type { Agent, Pod, Routine } from "@sugabots/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { Clock, Webhook } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { useAgents } from "@/lib/agents.ts";
import { failureMessage } from "@/lib/failure.ts";
import { newRoutineLink, routineSettingsLink } from "@/lib/links.ts";
import { usePods } from "@/lib/pods.ts";
import { scheduleLabel } from "@/lib/routine-schedule.ts";
import { useRoutines, useWorkspaceRoutines } from "@/lib/routines.ts";
import { useSettingsBack } from "@/lib/settings-back.tsx";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import {
	SettingsAddRow,
	SettingsGroup,
	SettingsListColumn,
	SettingsListDetail,
	SettingsListRow,
	SettingsRow,
	SettingsRowIcon,
	SettingsValue,
} from "@/ui/settings-page.tsx";
import {
	type BotChoice,
	NewRoutinePage,
	type PlacedRoutine,
	RoutinePage,
} from "./RoutineEditor.tsx";

const ROUTINES_NOTE = "Routines post into the bot's chat when they run.";

/**
 * Every routine in the workspace the person can reach, beside the open one
 * or the one being made.
 */
export function WorkspaceRoutinesSettings({
	workspaceId,
	selectedRoutineId,
	newRoutine,
}: {
	workspaceId: string;
	selectedRoutineId?: string;
	/** A routine being made, for the bot chosen already, if one is. */
	newRoutine?: { agentId: string | undefined };
}) {
	const routines = useWorkspaceRoutines(workspaceId);
	const pods = usePods();
	const { agents } = useAgents();
	const navigate = useNavigate();
	const returnTo = useSettingsBack();
	const [search, setSearch] = useState("");
	const needle = useDeferredValue(search.trim().toLowerCase());
	const podById = new Map(pods.data?.map((pod) => [pod.id, pod]));
	const placed = (routines.data?.items ?? []).flatMap((item): PlacedRoutine[] => {
		const pod = podById.get(item.pod.id);
		return pod ? [{ routine: item.routine, agent: item.agent, pod }] : [];
	});
	const shown = placed.filter(
		({ routine }) => needle === "" || routine.name.toLowerCase().includes(needle),
	);
	const choices = botChoices(agents ?? [], pods.data ?? []);
	// With none chosen, the first routine is open beside the list; on a phone the list comes first.
	const selected = newRoutine
		? undefined
		: selectedRoutineId
			? placed.find(({ routine }) => routine.id === selectedRoutineId)
			: placed[0];
	const toList = () =>
		navigate({ from: "/$workspace", to: "./settings/$section", params: { section: "routines" } });
	const open = (routine: Routine) => navigate({ ...routineSettingsLink(routine), replace: true });

	if (routines.isPending || pods.isPending) return null;

	return (
		<SettingsListDetail
			detailOpen={selectedRoutineId !== undefined || newRoutine !== undefined}
			listLink={{
				label: "Routines",
				render: (
					<Link from="/$workspace" to="./settings/$section" params={{ section: "routines" }} />
				),
			}}
			returnTo={returnTo}
			list={
				<SettingsListColumn
					title="Routines"
					newLabel="New routine"
					onNew={choices.length > 0 ? () => navigate(newRoutineLink()) : undefined}
					search={search}
					onSearch={setSearch}
				>
					{newRoutine && (
						<SettingsListRow
							picture={<RoutineIcon trigger="cron" paused={false} />}
							label="New routine"
							sub="Not created yet"
							selected
							render={<div />}
						/>
					)}
					{shown.map((one) => (
						<SettingsListRow
							key={one.routine.id}
							picture={
								<RoutineIcon
									trigger={one.routine.trigger.kind}
									paused={one.routine.state === "paused"}
								/>
							}
							label={one.routine.name}
							sub={`${scheduleLabel(one.routine)}, ${one.agent.name}`}
							trailing={one.routine.state === "paused" && <SettingsValue>Paused</SettingsValue>}
							selected={
								one.routine.id === selected?.routine.id && (selectedRoutineId ? true : "wide")
							}
							render={<Link {...routineSettingsLink(one.routine)} />}
						/>
					))}
					{routines.isError && (
						<li className="px-2.5 py-3">
							<Alert>{failureMessage(routines.error)}</Alert>
						</li>
					)}
				</SettingsListColumn>
			}
			detail={
				newRoutine ? (
					<NewRoutinePage
						choices={choices}
						initialAgentId={newRoutine.agentId}
						onCancel={toList}
						onCreated={open}
					/>
				) : selected ? (
					<RoutinePage key={selected.routine.id} placed={selected} onDeleted={toList} />
				) : (
					<EmptyState title="No routines yet">
						<p className="m-0 text-muted-foreground">
							Things bots do on a schedule, without being asked.
						</p>
						{choices.length > 0 && (
							<Button onClick={() => navigate(newRoutineLink())}>New routine</Button>
						)}
					</EmptyState>
				)
			}
		/>
	);
}

/** One bot's routines on its card, each opening its page, and a way to make one for the bot. */
export function AgentRoutines({ agent, pod }: { agent: Agent; pod: Pod }) {
	const routines = useRoutines(agent.id);
	const navigate = useNavigate();
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
			{list.map((routine) => (
				<SettingsRow
					key={routine.id}
					icon={<RoutineIcon trigger={routine.trigger.kind} paused={routine.state === "paused"} />}
					label={routine.name}
					sub={scheduleLabel(routine)}
					trailing={routine.state === "paused" && <SettingsValue>Paused</SettingsValue>}
					chevron
					render={<Link {...routineSettingsLink(routine)} />}
				/>
			))}
			{canManage && (
				<SettingsAddRow label="New routine" onClick={() => navigate(newRoutineLink(agent))} />
			)}
		</SettingsGroup>
	);
}

/** A clock for a schedule and a hook for a webhook, faded while the routine is paused. */
function RoutineIcon({
	trigger,
	paused,
}: {
	trigger: Routine["trigger"]["kind"];
	paused: boolean;
}) {
	const Icon = trigger === "cron" ? Clock : Webhook;
	return (
		<SettingsRowIcon className={paused ? "opacity-55" : undefined}>
			<Icon size={15} strokeWidth={2.2} />
		</SettingsRowIcon>
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
