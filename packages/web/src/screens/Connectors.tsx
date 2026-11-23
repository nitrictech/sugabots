import { useConnectors } from "@/lib/connectors.ts";
import { failureMessage } from "@/lib/failure.ts";
import { ownerName, type ResourceOwner, resourceProjectId } from "@/lib/resource-owner.tsx";
import { OwnerCrumb, OwnerPageCrumb } from "@/shell/BotCrumb.tsx";
import { Page } from "@/shell/Page.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { SettingsPage } from "@/ui/settings-page.tsx";
import { ConnectorPage } from "./ConnectorPage.tsx";
import { ConnectorsSettings, ProjectBotsConnectors } from "./ConnectorsSettings.tsx";

/**
 * A bot's or a project's connectors, as one of its own pages beside its
 * chats: the services it is connected to, each with what its tools are set
 * to, and adding another; or, with `connectorId`, that one on its own page.
 * A bot's are its default project's. A project's page shows its bots' own
 * too, which they use there as well.
 */
export function ConnectorsPage({
	owner,
	connectorId,
	signInError,
}: {
	owner: ResourceOwner;
	connectorId?: string;
	/** Why the OAuth sign-in that just returned here did not finish, in our own words. */
	signInError?: string;
}) {
	return connectorId === undefined ? (
		<ConnectorList owner={owner} signInError={signInError} />
	) : (
		<OneConnector key={connectorId} owner={owner} connectorId={connectorId} />
	);
}

function ConnectorList({ owner, signInError }: { owner: ResourceOwner; signInError?: string }) {
	return (
		<Page title="Connectors" parent={<OwnerCrumb owner={owner} />} place={{ kind: "owner", owner }}>
			<SettingsPage>
				<ConnectorsSettings owner={owner} signInError={signInError} />
				{"project" in owner && <ProjectBotsConnectors project={owner.project} />}
			</SettingsPage>
		</Page>
	);
}

/** One of the owner's connectors on its own page, under its Connectors. */
function OneConnector({ owner, connectorId }: { owner: ResourceOwner; connectorId: string }) {
	const connectors = useConnectors(resourceProjectId(owner));
	const connector = connectors.data?.find((one) => one.id === connectorId);
	return (
		<Page
			title={connector?.name ?? "Connector"}
			parent={<OwnerPageCrumb owner={owner} page="connectors" />}
			place={{ kind: "owner", owner }}
		>
			{connectors.isPending ? null : connector ? (
				<ConnectorPage connector={connector} owner={owner} />
			) : (
				<EmptyState
					page="min"
					title={connectors.isError ? "Could not load this connector" : "No such connector here"}
				>
					{connectors.isError
						? failureMessage(connectors.error)
						: `It may have been removed from ${ownerName(owner)}.`}
				</EmptyState>
			)}
		</Page>
	);
}
