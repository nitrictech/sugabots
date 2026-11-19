import { useState } from "react";
import { useConnections } from "@/lib/connections.ts";
import { failureMessage } from "@/lib/failure.ts";
import { useProjectBots } from "@/lib/projects.ts";
import {
	ownerLink,
	ownerName,
	type ResourceOwner,
	resourcePermissions,
	resourceProjectId,
} from "@/lib/resource-owner.tsx";
import { useBackTarget } from "@/lib/settings-back.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { PageBackLink, SettingsAddButton, SettingsPage } from "@/ui/settings-page.tsx";
import { ConnectionPage } from "./ConnectionPage.tsx";
import { ConnectionsSettings } from "./ConnectionsSettings.tsx";
import { ProjectComputerSettings } from "./ProjectComputerSettings.tsx";

/*
 * The settings pages a bot and a project each have for what they hold: their
 * connections, one connection, and their computer. A bot's are its default
 * project's.
 */

/** The services `owner` is connected to, each with what its tools are set to, and adding another. */
export function ConnectionsSettingsPage({
	owner,
	signInError,
}: {
	/** The bot or project, whose permissions say what the person may change. */
	owner: ResourceOwner;
	/** Why the OAuth sign-in that just returned here did not finish, in our own words. */
	signInError?: string;
}) {
	const [adding, setAdding] = useState(false);
	const name = ownerName(owner);
	const canManage = resourcePermissions(owner).manageConnections;
	const back = useBackTarget({ label: name, render: ownerLink(owner, { page: "settings" }) });
	return (
		<SettingsPage
			back={<PageBackLink {...back} />}
			title="Connections"
			description={
				"bot" in owner
					? `The services ${name} uses, as whoever connected each one.`
					: `The services the bots in ${name} use there, as whoever connected each one.`
			}
			headerAction={
				canManage && (
					<SettingsAddButton onClick={() => setAdding(true)}>Add connection</SettingsAddButton>
				)
			}
		>
			<ConnectionsSettings
				owner={owner}
				canManage={canManage}
				signInError={signInError}
				adding={adding}
				onAddingChange={setAdding}
			/>
		</SettingsPage>
	);
}

/** One of the owner's connections on its own page, with Back to its Connections. */
export function ConnectionSettingsPage({
	owner,
	connectionId,
}: {
	owner: ResourceOwner;
	connectionId: string;
}) {
	const connections = useConnections(resourceProjectId(owner));
	const back = useBackTarget({
		label: "Connections",
		render: ownerLink(owner, { page: "connections" }),
	});
	const connection = connections.data?.find((one) => one.id === connectionId);
	if (connections.isPending) return null;
	if (!connection) {
		return (
			<EmptyState
				page
				title={connections.isError ? "Could not load this connection" : "No such connection here"}
			>
				{connections.isError
					? failureMessage(connections.error)
					: `It may have been removed from ${ownerName(owner)}.`}
			</EmptyState>
		);
	}
	return <ConnectionPage connection={connection} owner={owner} back={<PageBackLink {...back} />} />;
}

/** The owner's computer: how it stands, its disk, and the hosts it may reach. */
export function ComputerSettingsPage({ owner }: { owner: ResourceOwner }) {
	const name = ownerName(owner);
	const back = useBackTarget({ label: name, render: ownerLink(owner, { page: "settings" }) });
	// The bots whose homes the disk's folders may be: a bot alone, or a project's bots.
	const projectBots = useProjectBots("project" in owner ? owner.project.id : undefined).data;
	const bots = "bot" in owner ? [owner.bot] : (projectBots ?? []);
	return (
		<SettingsPage
			back={<PageBackLink {...back} />}
			title="Computer"
			description={
				"bot" in owner
					? `The computer ${name} runs commands, browses and edits files on. Experimental.`
					: `The computer the bots in ${name} run commands, browse and edit files on there. Experimental.`
			}
		>
			<ProjectComputerSettings owner={owner} bots={bots} />
		</SettingsPage>
	);
}
