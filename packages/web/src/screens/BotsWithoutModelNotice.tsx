import type { Bot } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { useBots, useModels } from "@/lib/bots.ts";
import { botSettingsLink, settingsSectionLink } from "@/lib/links.ts";
import { useWorkspacePermissions } from "@/lib/workspace.ts";
import { buttonStyles } from "@/ui/button.tsx";
import { WarningText } from "@/ui/warning-text.tsx";
import { type DraftFloor, requiredRepliers } from "./chat-recipients.ts";

/**
 * What the composer shows of the bots that must reply to a draft under
 * `floor`: those with no model, for which the server refuses the message
 * while there are any, and the model that answers, the first bot's if
 * several must. A bot not yet in the workspace's roster is left out
 * of `withoutModel` until it is.
 */
export function useRequiredRepliers(floor: DraftFloor): {
	withoutModel: Bot[];
	model: string | undefined;
} {
	const roster = useBots().bots ?? [];
	const repliers = requiredRepliers(floor).map((replier) =>
		roster.find((one) => one.id === replier.id),
	);
	const withoutModel = repliers.filter((bot): bot is Bot => bot?.model === null);
	return { withoutModel, model: repliers[0]?.model ?? undefined };
}

/**
 * By Send, in the model's place, each bot the message must go to that has no
 * model, and so can't answer, with what would give it one.
 */
export function BotsWithoutModelNotice({ bots }: { bots: readonly Bot[] }) {
	return bots.map((bot) => (
		<WarningText key={bot.id}>
			{bot.name} has no model yet. <GivingItAModel bot={bot} />
		</WarningText>
	));
}

/**
 * What gives `bot` a model. A Personal Assistant starts with the workspace's
 * default, so when the workspace offers none, a provider needs to be set up.
 */
function GivingItAModel({ bot }: { bot: Bot }) {
	const manageProviders = useWorkspacePermissions().manageProviders;
	const { data: models } = useModels(bot.assistant);
	if (bot.assistant && models?.models.length === 0) {
		if (!manageProviders) return "A workspace administrator switches on a model for it.";
		return (
			<>
				<Link
					{...settingsSectionLink("providers")}
					className={buttonStyles({ variant: "link", size: "bare" })}
				>
					Switch on a model
				</Link>{" "}
				to send this.
			</>
		);
	}
	if (!bot.permissions.update) return "Somebody who can change this bot chooses its model.";
	return (
		<>
			<Link {...botSettingsLink(bot)} className={buttonStyles({ variant: "link", size: "bare" })}>
				Choose a model
			</Link>{" "}
			to send this.
		</>
	);
}
