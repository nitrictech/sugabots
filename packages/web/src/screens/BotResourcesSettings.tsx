import type { Bot } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useConnections } from "@/lib/connections.ts";
import { failureMessage } from "@/lib/failure.ts";
import { botSettingsLink, botSettingsPageLink } from "@/lib/links.ts";
import { useBackTarget } from "@/lib/settings-back.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { PageBackLink, SettingsAddButton, SettingsPage } from "@/ui/settings-page.tsx";
import { BotComputerSettings } from "./BotComputerSettings.tsx";
import { ConnectionPage } from "./ConnectionPage.tsx";
import { ConnectionsSettings } from "./ConnectionsSettings.tsx";

/** The services `bot` is connected to, each with what its tools are set to, and adding another. */
export function BotConnectionsSettings({
	bot,
	signInError,
}: {
	/** The bot, whose permissions say what the person may change. */
	bot: Bot;
	/** Why the OAuth sign-in that just returned here did not finish, in our own words. */
	signInError?: string;
}) {
	const [adding, setAdding] = useState(false);
	const back = useBackTarget({ label: bot.name, render: <Link {...botSettingsLink(bot)} /> });
	return (
		<SettingsPage
			back={<PageBackLink {...back} />}
			title="Connections"
			description={`The services ${bot.name} uses, as whoever connected each one.`}
			headerAction={
				bot.permissions.manageConnections && (
					<SettingsAddButton onClick={() => setAdding(true)}>Add connection</SettingsAddButton>
				)
			}
		>
			<ConnectionsSettings
				bot={bot}
				canManage={bot.permissions.manageConnections}
				signInError={signInError}
				adding={adding}
				onAddingChange={setAdding}
			/>
		</SettingsPage>
	);
}

/** One of the bot's connections on its own page, with Back to its Connections. */
export function BotConnection({ bot, connectionId }: { bot: Bot; connectionId: string }) {
	const connections = useConnections(bot.id);
	const back = useBackTarget({
		label: "Connections",
		render: <Link {...botSettingsPageLink(bot, "connections")} />,
	});
	const connection = connections.data?.find((one) => one.id === connectionId);
	if (connections.isPending) return null;
	if (!connection) {
		return (
			<div className="grid min-h-80 place-items-center p-6">
				<EmptyState
					title={connections.isError ? "Could not load this connection" : "No such connection here"}
				>
					{connections.isError
						? failureMessage(connections.error)
						: `It may have been removed from ${bot.name}.`}
				</EmptyState>
			</div>
		);
	}
	return <ConnectionPage connection={connection} bot={bot} back={<PageBackLink {...back} />} />;
}

/** The bot's computer: how it stands, its disk, and the hosts it may reach. */
export function BotComputerPage({ bot }: { bot: Bot }) {
	const back = useBackTarget({ label: bot.name, render: <Link {...botSettingsLink(bot)} /> });
	return (
		<SettingsPage
			back={<PageBackLink {...back} />}
			title="Computer"
			description={`The computer ${bot.name} runs commands, browses and edits files on. Experimental.`}
		>
			<BotComputerSettings
				botId={bot.id}
				bots={[bot]}
				canManageNetwork={bot.permissions.manageComputer}
			/>
		</SettingsPage>
	);
}
