import type { Agent, Pod } from "@sugabots/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { useAgents } from "@/lib/agents.ts";
import { routinesLink, routineThreadLink } from "@/lib/links.ts";
import { useRoutines } from "@/lib/routines.ts";
import { useLeave } from "@/ui/back-button.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { CompactBackBar, SettingsGroup, SettingsRow, SettingsValue } from "@/ui/settings-page.tsx";
import { NewRoutinePage } from "./RoutineEditor.tsx";

/*
 * Making routines beside a pod's Routines list rather than in
 * settings: a routine belongs to a bot, and a bot to its pod, so the pod's
 * page is where its routines are kept.
 */

/**
 * A routine being made in `pod`, for the bot `botHandle` names when it was
 * begun from that bot's routines. Once made, its own thread opens, where its
 * runs will post.
 */
export function NewRoutine({ pod, botHandle }: { pod: Pod; botHandle: string | undefined }) {
	const { agents } = useAgents();
	const navigate = useNavigate();
	const { leave } = useLeave();
	const crew = (agents ?? []).filter(
		(agent) => agent.podId === pod.id && agent.systemAgentKey === null,
	);
	const bot = crew.find((agent) => agent.handle === botHandle);
	// Leaving without making one goes back as Back does, so the routines' own Back doesn't
	// return here; the routines take this page's place when nothing came before it.
	const cancel = () => {
		leave(() => void navigate({ ...routinesLink(pod, bot), replace: true }));
	};
	if (!agents) return null;
	if (!pod.permissions.manageRoutines || crew.length === 0) {
		return (
			<EmptyState title="No routine can be made here">
				{pod.permissions.manageRoutines
					? `${pod.name} has no bots to run one yet.`
					: `Only people who manage ${pod.name}'s routines can make one.`}
			</EmptyState>
		);
	}
	return (
		// A group, so its Back can stand aside for one a page inside draws itself, as Instructions does.
		<div className="group/routine tab-bar-clearance min-h-0 flex-1 overflow-y-auto">
			<BackToRoutines pod={pod} bot={bot} />
			<NewRoutinePage
				choices={crew.map((agent) => ({ agent, pod }))}
				initialAgentId={bot?.id}
				onCancel={cancel}
				onCreated={(routine) =>
					void navigate({ ...routineThreadLink(pod, routine.id), replace: true })
				}
			/>
		</div>
	);
}

/**
 * On a phone, where the routine covers the list, the way back to it: the
 * bot's routines when the page is one bot's, else the pod's.
 */
function BackToRoutines({ pod, bot }: { pod: Pod; bot: Agent | undefined }) {
	return (
		<CompactBackBar
			label="Routines"
			render={<Link {...routinesLink(pod, bot)} />}
			className="group-has-[[data-page-back]]/routine:hidden md:hidden"
		/>
	);
}

/**
 * One bot's routines on its card, as how many it has. They are made and
 * changed on the bot's Routines page beside its chats, which the row opens.
 */
export function AgentRoutines({ agent, pod }: { agent: Agent; pod: Pod }) {
	const routines = useRoutines(agent.id);
	const count = routines.data?.length;
	return (
		<SettingsGroup>
			<SettingsRow
				label="Routines"
				sub={`What ${agent.name} does without being asked. Set up on its Routines page.`}
				trailing={
					count !== undefined && <SettingsValue>{count === 0 ? "None" : count}</SettingsValue>
				}
				chevron
				render={<Link {...routinesLink(pod, agent)} />}
			/>
		</SettingsGroup>
	);
}
