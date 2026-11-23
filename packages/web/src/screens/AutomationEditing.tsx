import type { Bot } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { useAutomations } from "@/lib/automations.ts";
import { API_DID_NOT_ANSWER } from "@/lib/failure.ts";
import { botAutomationsLink } from "@/lib/links.ts";
import {
	ownerLink,
	ownerName,
	type ResourceOwner,
	resourcePermissions,
	resourceProjectId,
	useNavigateToOwnerPage,
} from "@/lib/resource-owner.tsx";
import { useListedAutomations } from "@/shell/Automations.tsx";
import { OwnerPageCrumb } from "@/shell/BotCrumb.tsx";
import { PageHeader } from "@/shell/Page.tsx";
import { useLeave } from "@/ui/back-button.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { CompactBackBar, SettingsGroup, SettingsRow, SettingsValue } from "@/ui/settings-page.tsx";
import { NewAutomationPage } from "./AutomationEditor.tsx";
import { AutomationPanel } from "./AutomationPanel.tsx";

/*
 * Making automations among a bot's or a project's pages rather than in
 * settings: an automation belongs to a project, a bot's to its default one,
 * so the bot's or project's pages are where its automations are kept.
 */

/** An automation being made for `owner`, under its breadcrumb. Once made, its own page opens. */
export function NewAutomation({ owner }: { owner: ResourceOwner }) {
	const navigateToOwnerPage = useNavigateToOwnerPage();
	const { leave } = useLeave();
	// Leaving without making one goes back as Back does, so the automations' own Back doesn't
	// return here. With nothing before it, the bot's or project's page takes its place: its
	// automations would bring one with none straight back here.
	const cancel = () => {
		leave(() => void navigateToOwnerPage(owner, { page: "home" }, { replace: true }));
	};
	if (!resourcePermissions(owner).manageAutomations) {
		return (
			<EmptyState title="No automation can be made here">
				Only people who manage {ownerName(owner)} can make one.
			</EmptyState>
		);
	}
	return (
		// A group, so its Back can stand aside for one a page inside draws itself, as Instructions does.
		<div className="group/automation tab-bar-clearance min-h-0 flex-1 overflow-y-auto">
			<BackToAutomations owner={owner} />
			<div className="max-md:hidden">
				<PageHeader
					title="New automation"
					parent={<OwnerPageCrumb owner={owner} page="automations" />}
					place={{ kind: "owner", owner }}
				/>
			</div>
			<NewAutomationPage
				owner={owner}
				onCancel={cancel}
				onCreated={(automation) =>
					void navigateToOwnerPage(
						owner,
						{ page: "automation", automationId: automation.id },
						{ replace: true },
					)
				}
			/>
		</div>
	);
}

/**
 * One of `owner`'s automations as its own page: how it is set up, under its
 * breadcrumb, with whether it runs and Run now at the top. Somebody who
 * manages its automations without reaching the bot, as an administrator does
 * another person's private bot, changes it the same way, but how it ran is
 * not theirs to read.
 */
export function AutomationSetup({
	owner,
	automationId,
}: {
	owner: ResourceOwner;
	automationId: string;
}) {
	const automations = useAutomations(resourceProjectId(owner));
	const listed = useListedAutomations(owner).automations?.find(
		(row) => row.automation.id === automationId,
	);
	if (automations.isPending) return null;
	const automation = automations.data?.find((one) => one.id === automationId);
	if (!automation) {
		return (
			<EmptyState
				title={automations.isError ? "Could not load this automation" : "No such automation"}
			>
				{automations.isError ? API_DID_NOT_ANSWER : "It may have been removed."}
			</EmptyState>
		);
	}
	return (
		<div className="group/automation flex min-h-0 flex-1 flex-col">
			<BackToAutomations owner={owner} />
			<AutomationPanel
				owner={owner}
				conversationId={listed?.conversation?.id}
				standing={{
					id: automation.id,
					projectId: automation.projectId,
					state: automation.state,
					pausedAfterFailures: automation.pausedAfterFailures,
				}}
				onClose={undefined}
			/>
		</div>
	);
}

/** On a phone, where the automation covers the list, the way back to the owner's automations. */
function BackToAutomations({ owner }: { owner: ResourceOwner }) {
	return (
		<CompactBackBar
			label="Automations"
			render={ownerLink(owner, { page: "automations" })}
			className="group-has-[[data-page-back]]/automation:hidden md:hidden"
		/>
	);
}

/**
 * One bot's automations on its card, as how many it has. They are made and
 * changed on the bot's Automations page, which the row opens.
 */
export function BotAutomations({ bot }: { bot: Bot }) {
	const automations = useAutomations(bot.defaultProjectId);
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
				render={<Link {...botAutomationsLink(bot)} />}
			/>
		</SettingsGroup>
	);
}
