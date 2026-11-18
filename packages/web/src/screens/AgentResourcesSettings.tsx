import type { Agent } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useConnections } from "@/lib/connections.ts";
import { failureMessage } from "@/lib/failure.ts";
import { agentSettingsLink, agentSettingsPageLink } from "@/lib/links.ts";
import { useBackTarget } from "@/lib/settings-back.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { PageBackLink, SettingsAddButton, SettingsPage } from "@/ui/settings-page.tsx";
import { AgentSandboxSettings } from "./AgentSandboxSettings.tsx";
import { ConnectionPage } from "./ConnectionPage.tsx";
import { ConnectionsSettings } from "./ConnectionsSettings.tsx";

/** The services `bot` is connected to, each with what its tools are set to, and adding another. */
export function AgentConnectionsSettings({
	agent,
	signInError,
}: {
	/** The bot, whose permissions say what the person may change. */
	agent: Agent;
	/** Why the OAuth sign-in that just returned here did not finish, in our own words. */
	signInError?: string;
}) {
	const [adding, setAdding] = useState(false);
	const back = useBackTarget({ label: agent.name, render: <Link {...agentSettingsLink(agent)} /> });
	return (
		<SettingsPage
			back={<PageBackLink {...back} />}
			title="Connections"
			description={`The services ${agent.name} uses, as whoever connected each one.`}
			headerAction={
				agent.permissions.manageConnections && (
					<SettingsAddButton onClick={() => setAdding(true)}>Add connection</SettingsAddButton>
				)
			}
		>
			<ConnectionsSettings
				agent={agent}
				canManage={agent.permissions.manageConnections}
				signInError={signInError}
				adding={adding}
				onAddingChange={setAdding}
			/>
		</SettingsPage>
	);
}

/** One of the bot's connections on its own page, with Back to its Connections. */
export function AgentConnection({ agent, connectionId }: { agent: Agent; connectionId: string }) {
	const connections = useConnections(agent.id);
	const back = useBackTarget({
		label: "Connections",
		render: <Link {...agentSettingsPageLink(agent, "connections")} />,
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
						: `It may have been removed from ${agent.name}.`}
				</EmptyState>
			</div>
		);
	}
	return <ConnectionPage connection={connection} agent={agent} back={<PageBackLink {...back} />} />;
}

/** The bot's's computer: how it stands, its disk, and the hosts it may reach. */
export function AgentComputerSettings({ agent }: { agent: Agent }) {
	const back = useBackTarget({ label: agent.name, render: <Link {...agentSettingsLink(agent)} /> });
	return (
		<SettingsPage
			back={<PageBackLink {...back} />}
			title="Computer"
			description={`The computer ${agent.name} runs commands, browses and edits files on. Experimental.`}
		>
			<AgentSandboxSettings
				agentId={agent.id}
				bots={[agent]}
				canManageNetwork={agent.permissions.manageSandbox}
			/>
		</SettingsPage>
	);
}
