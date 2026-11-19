import { Plus } from "lucide-react";
import { useState } from "react";
import { useConnections } from "@/lib/connections.ts";
import { failureMessage } from "@/lib/failure.ts";
import {
	ownerName,
	type ResourceOwner,
	resourcePermissions,
	resourceProjectId,
} from "@/lib/resource-owner.tsx";
import { OwnerCrumb, OwnerPageCrumb } from "@/shell/BotCrumb.tsx";
import { Page } from "@/shell/Page.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { FLOATING_ON_PHONE, IconButton } from "@/ui/icon-button.tsx";
import { SettingsPage } from "@/ui/settings-page.tsx";
import { ConnectionPage } from "./ConnectionPage.tsx";
import { ConnectionsSettings } from "./ConnectionsSettings.tsx";

/**
 * A bot's or a project's connections, as one of its own pages beside its
 * threads: the services it is connected to, each with what its tools are set
 * to, and adding another; or, with `connectionId`, that one on its own page.
 * A bot's are its default project's.
 */
export function ConnectionsPage({
	owner,
	connectionId,
	signInError,
}: {
	owner: ResourceOwner;
	connectionId?: string;
	/** Why the OAuth sign-in that just returned here did not finish, in our own words. */
	signInError?: string;
}) {
	return connectionId === undefined ? (
		<ConnectionList owner={owner} signInError={signInError} />
	) : (
		<OneConnection key={connectionId} owner={owner} connectionId={connectionId} />
	);
}

function ConnectionList({ owner, signInError }: { owner: ResourceOwner; signInError?: string }) {
	const [adding, setAdding] = useState(false);
	const name = ownerName(owner);
	const canManage = resourcePermissions(owner).manageConnections;
	return (
		<Page
			title="Connections"
			parent={<OwnerCrumb owner={owner} />}
			place={{ kind: "owner", owner }}
			actions={
				canManage && (
					<IconButton
						label="Add connection"
						variant="bar"
						onClick={() => setAdding(true)}
						className={FLOATING_ON_PHONE}
					>
						<Plus size={16} strokeWidth={1.75} />
					</IconButton>
				)
			}
		>
			<SettingsPage
				description={
					"bot" in owner
						? `The services ${name} uses, as whoever connected each one.`
						: `The services the bots in ${name} use there, as whoever connected each one.`
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
		</Page>
	);
}

/** One of the owner's connections on its own page, under its Connections. */
function OneConnection({ owner, connectionId }: { owner: ResourceOwner; connectionId: string }) {
	const connections = useConnections(resourceProjectId(owner));
	const connection = connections.data?.find((one) => one.id === connectionId);
	return (
		<Page
			title={connection?.name ?? "Connection"}
			parent={<OwnerPageCrumb owner={owner} page="connections" />}
			place={{ kind: "owner", owner }}
		>
			{connections.isPending ? null : connection ? (
				<ConnectionPage connection={connection} owner={owner} />
			) : (
				<EmptyState
					page="min"
					title={connections.isError ? "Could not load this connection" : "No such connection here"}
				>
					{connections.isError
						? failureMessage(connections.error)
						: `It may have been removed from ${ownerName(owner)}.`}
				</EmptyState>
			)}
		</Page>
	);
}
