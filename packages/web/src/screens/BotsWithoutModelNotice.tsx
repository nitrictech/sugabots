import type { Bot } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { useBots, useModelName } from "@/lib/bots.ts";
import { botSettingsLink } from "@/lib/links.ts";
import { useWorkspacePermissions } from "@/lib/workspace.ts";
import { buttonStyles } from "@/ui/button.tsx";
import { WarningText } from "@/ui/warning-text.tsx";
import { ComposerStrip } from "./ChatComposer.tsx";
import { type DraftFloor, requiredRepliers } from "./chat-recipients.ts";

/**
 * What the composer shows of the bots that must reply to a draft under
 * `floor`: those with no model, for which the server refuses the message
 * while there are any, and the name of the model that answers, the first
 * bot's if several must. A bot not yet in the workspace's roster is left out
 * of `withoutModel` until it is.
 */
export function useRequiredRepliers(floor: DraftFloor): {
	withoutModel: Bot[];
	modelName: string | undefined;
} {
	const roster = useBots().bots ?? [];
	const repliers = requiredRepliers(floor).map((replier) =>
		roster.find((one) => one.id === replier.id),
	);
	const withoutModel = repliers.filter((bot): bot is Bot => bot?.model === null);
	const modelName = useModelName(repliers[0]?.model ?? null);
	return { withoutModel, modelName: modelName ?? undefined };
}

/**
 * Over the draft, as a strip like the one for a reply, each bot the message
 * must go to that has no model, and so can't answer, with what would give it one.
 */
export function BotsWithoutModelNotice({ bots }: { bots: readonly Bot[] }) {
	return (
		<ComposerStrip className="flex-col items-start gap-1">
			{bots.map((bot) => (
				<WarningText key={bot.id}>
					{bot.name} has no model yet, so it cannot answer. <GivingItAModel bot={bot} />
				</WarningText>
			))}
		</ComposerStrip>
	);
}

/**
 * What gives `bot` a model, for the person reading. An ordinary bot's model is
 * chosen in its settings, by whoever may change it. A Personal Assistant's is
 * Sugabots' to set, so it has none only while the workspace has no model
 * switched on, which only somebody who manages its providers can change.
 */
function GivingItAModel({ bot }: { bot: Bot }) {
	const manageProviders = useWorkspacePermissions().manageProviders;
	if (bot.assistant) {
		if (!manageProviders) return "A workspace administrator switches on a model for it.";
		return (
			<>
				<Link
					from="/$workspace"
					to="./settings/$section"
					params={{ section: "providers" }}
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
