import { Link } from "@tanstack/react-router";
import { useBots } from "@/lib/bots.ts";
import { failureMessage } from "@/lib/failure.ts";
import { botSettingsLink } from "@/lib/links.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { BotAvatar } from "@/shell/Bot.tsx";
import { useNewBot } from "@/shell/NewBot.tsx";
import { Alert } from "@/ui/alert.tsx";
import {
	SettingsAddButton,
	SettingsGroup,
	SettingsPage,
	SettingsRow,
} from "@/ui/settings-page.tsx";

/**
 * Every bot the person reaches, as the Bots section lists them, with making
 * another. Each opens its own settings.
 */
export function WorkspaceBotsSettings({ canCreate }: { canCreate: boolean }) {
	const { bots: reachable, isPending, error } = useBots();
	const newBot = useNewBot();
	const backToBots = useBackToHere("Bots");
	const bots = reachable ?? [];
	if (isPending) return null;
	return (
		<SettingsPage
			title="Bots"
			description="Public bots everyone can talk to, your private ones, and your Personal Assistant."
			headerAction={
				canCreate &&
				newBot.start && <SettingsAddButton onClick={newBot.start}>New bot</SettingsAddButton>
			}
		>
			{error ? <Alert>{failureMessage(error)}</Alert> : null}
			<SettingsGroup>
				{bots.map((bot) => (
					<SettingsRow
						key={bot.id}
						icon={<BotAvatar color={bot.color} face={bot.face} shape={bot.shape} size={24} />}
						label={bot.name}
						sub={
							bot.assistant
								? "Your Personal Assistant"
								: bot.visibility === "private"
									? "Private"
									: bot.description || undefined
						}
						chevron
						render={<Link {...botSettingsLink(bot)} state={backToBots} />}
					/>
				))}
			</SettingsGroup>
			{newBot.dialog}
		</SettingsPage>
	);
}
