import type { Agent } from "@sugabots/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { routinesLink, routineThreadLink } from "@/lib/links.ts";
import { useRoutines } from "@/lib/routines.ts";
import { useLeave } from "@/ui/back-button.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { CompactBackBar, SettingsGroup, SettingsRow, SettingsValue } from "@/ui/settings-page.tsx";
import { NewRoutinePage } from "./RoutineEditor.tsx";

/*
 * Making automations beside a bot's Automations list rather than in
 * settings: an automation belongs to a bot, so the bot's page is where its
 * automations are kept.
 */

/** An automation being made for `agent`. Once made, its own thread opens, where its runs will post. */
export function NewRoutine({ agent }: { agent: Agent }) {
	const navigate = useNavigate();
	const { leave } = useLeave();
	// Leaving without making one goes back as Back does, so the automations' own Back doesn't
	// return here; the automations take this page's place when nothing came before it.
	const cancel = () => {
		leave(() => void navigate({ ...routinesLink(agent), replace: true }));
	};
	if (!agent.permissions.manageRoutines) {
		return (
			<EmptyState title="No automation can be made here">
				Only people who manage {agent.name} can make one.
			</EmptyState>
		);
	}
	return (
		// A group, so its Back can stand aside for one a page inside draws itself, as Instructions does.
		<div className="group/routine tab-bar-clearance min-h-0 flex-1 overflow-y-auto">
			<BackToRoutines agent={agent} />
			<NewRoutinePage
				choices={[{ agent }]}
				initialAgentId={agent.id}
				onCancel={cancel}
				onCreated={(routine) =>
					void navigate({ ...routineThreadLink(agent, routine.id), replace: true })
				}
			/>
		</div>
	);
}

/** On a phone, where the automation covers the list, the way back to the bot's automations. */
function BackToRoutines({ agent }: { agent: Agent }) {
	return (
		<CompactBackBar
			label="Automations"
			render={<Link {...routinesLink(agent)} />}
			className="group-has-[[data-page-back]]/routine:hidden md:hidden"
		/>
	);
}

/**
 * One bot's automations on its card, as how many it has. They are made and
 * changed on the bot's Automations page beside its tasks, which the row opens.
 */
export function AgentRoutines({ agent }: { agent: Agent }) {
	const routines = useRoutines(agent.id);
	const count = routines.data?.length;
	return (
		<SettingsGroup>
			<SettingsRow
				label="Automations"
				sub={`What ${agent.name} does without being asked. Set up on its Automations page.`}
				trailing={
					count !== undefined && <SettingsValue>{count === 0 ? "None" : count}</SettingsValue>
				}
				chevron
				render={<Link {...routinesLink(agent)} />}
			/>
		</SettingsGroup>
	);
}
