import type { Bot } from "@sugabots/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { useAutomations } from "@/lib/automations.ts";
import { automationFeedLink, automationsLink } from "@/lib/links.ts";
import { useLeave } from "@/ui/back-button.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { CompactBackBar, SettingsGroup, SettingsRow, SettingsValue } from "@/ui/settings-page.tsx";
import { NewAutomationPage } from "./AutomationEditor.tsx";
import { AutomationPanel } from "./AutomationPanel.tsx";

/*
 * Making automations beside a bot's Automations list rather than in
 * settings: an automation belongs to a bot, so the bot's page is where its
 * automations are kept.
 */

/** An automation being made for `bot`. Once made, its feed opens, where its runs will post. */
export function NewAutomation({ bot }: { bot: Bot }) {
	const navigate = useNavigate();
	const { leave } = useLeave();
	// Leaving without making one goes back as Back does, so the automations' own Back doesn't
	// return here; the automations take this page's place when nothing came before it.
	const cancel = () => {
		leave(() => void navigate({ ...automationsLink(bot), replace: true }));
	};
	if (!bot.permissions.manageAutomations) {
		return (
			<EmptyState title="No automation can be made here">
				Only people who manage {bot.name} can make one.
			</EmptyState>
		);
	}
	return (
		// A group, so its Back can stand aside for one a page inside draws itself, as Instructions does.
		<div className="group/automation tab-bar-clearance min-h-0 flex-1 overflow-y-auto">
			<BackToAutomations bot={bot} />
			<NewAutomationPage
				choices={[{ bot }]}
				initialBotId={bot.id}
				onCancel={cancel}
				onCreated={(automation) =>
					void navigate({ ...automationFeedLink(bot, automation.id), replace: true })
				}
			/>
		</div>
	);
}

/**
 * How one of `bot`'s automations is set up, as the page beside its list, for
 * somebody who manages its automations without reaching the bot, as an
 * administrator does another person's private bot: they change it, but its
 * feed, where its runs post, is not theirs to read.
 */
export function AutomationSetup({ bot, automationId }: { bot: Bot; automationId: string }) {
	const automations = useAutomations(bot.id);
	if (automations.isPending) return null;
	const automation = automations.data?.find((one) => one.id === automationId);
	if (!automation) {
		return (
			<EmptyState
				title={automations.isError ? "Could not load this automation" : "No such automation"}
			>
				{automations.isError
					? "The API did not answer. Reload this page to try again."
					: "It may have been removed."}
			</EmptyState>
		);
	}
	return (
		<div className="group/automation flex min-h-0 flex-1 flex-col">
			<BackToAutomations bot={bot} />
			<AutomationPanel
				bot={bot}
				conversationId={undefined}
				// Whether it failed is run history, which they do not read.
				standing={{
					id: automation.id,
					botId: automation.botId,
					state: automation.state,
					failed: false,
					pausedAfterFailures: false,
				}}
				onClose={undefined}
			/>
		</div>
	);
}

/** On a phone, where the automation covers the list, the way back to the bot's automations. */
function BackToAutomations({ bot }: { bot: Bot }) {
	return (
		<CompactBackBar
			label="Automations"
			render={<Link {...automationsLink(bot)} />}
			className="group-has-[[data-page-back]]/automation:hidden md:hidden"
		/>
	);
}

/**
 * One bot's automations on its card, as how many it has. They are made and
 * changed on the bot's Automations page beside its tasks, which the row opens.
 */
export function BotAutomations({ bot }: { bot: Bot }) {
	const automations = useAutomations(bot.id);
	const count = automations.data?.length;
	return (
		<SettingsGroup>
			<SettingsRow
				label="Automations"
				sub={`What ${bot.name} does without being asked. Set up on its Automations page.`}
				trailing={
					count !== undefined && <SettingsValue>{count === 0 ? "None" : count}</SettingsValue>
				}
				chevron
				render={<Link {...automationsLink(bot)} />}
			/>
		</SettingsGroup>
	);
}
