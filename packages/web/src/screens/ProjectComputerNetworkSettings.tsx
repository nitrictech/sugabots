import { useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { useProjectComputerNetwork } from "@/lib/project-computer.ts";
import {
	type ResourceOwner,
	resourcePermissions,
	resourceProjectId,
} from "@/lib/resource-owner.tsx";
import { Alert } from "@/ui/alert.tsx";
import { SettingsGroup, SettingsRow } from "@/ui/settings-page.tsx";
import { AddedHostRow, AddHostRow } from "./ComputerNetworkSettings.tsx";

/**
 * What the owner's computer may connect to: the hosts the workspace allows
 * every computer, and the project's own, added here or by allowing a bot's
 * request in a thread, which only someone who manages the owner's computer
 * may change.
 */
export function ProjectComputerNetworkSettings({ owner }: { owner: ResourceOwner }) {
	const canManage = resourcePermissions(owner).manageComputer;
	const { network, addHost, removeHost } = useProjectComputerNetwork(resourceProjectId(owner));
	const [showingWorkspace, setShowingWorkspace] = useState(false);
	if (network.isPending) return null;
	if (network.isError) return <Alert>{failureMessage(network.error)}</Alert>;

	const { mode, blocking, workspaceHosts, addedHosts } = network.data;
	if (mode === "open") {
		return (
			<SettingsGroup
				label="Network"
				note="The workspace's computers are open. Its admins choose this, and any hosts it blocks, in its computer settings."
			>
				<SettingsRow
					label="Open"
					sub={blocking ? "Any host the workspace hasn't blocked" : "Any host"}
				/>
			</SettingsGroup>
		);
	}

	const ownerWord = "bot" in owner ? "bot" : "project";
	const pending = addHost.isPending || removeHost.isPending;
	const error = addHost.error ?? removeHost.error;
	const reachable = workspaceHosts.filter((entry) => entry.blockedBy === null);
	return (
		<>
			<SettingsGroup
				label="Network"
				note={`This ${ownerWord}'s computer connects to the workspace's hosts and these. When it needs another, a bot asks in a thread, and ${canManage ? "you can allow it there" : `someone who manages the ${ownerWord} decides`}.`}
			>
				{addedHosts.map((added) => (
					<AddedHostRow
						key={added.host}
						added={added}
						blockedBy={added.blockedBy}
						disabled={pending}
						onRemove={canManage ? () => removeHost.mutate(added.host) : undefined}
					/>
				))}
				{canManage && (
					<AddHostRow
						label="Add host"
						action="Add"
						disabled={pending}
						onAdd={(host) => addHost.mutateAsync(host)}
					/>
				)}
				<SettingsRow
					label="From the workspace"
					sub={
						showingWorkspace
							? reachable.map((entry) => entry.host).join(", ")
							: `${reachable.length} hosts every computer reaches: GitHub, package registries and the workspace's own`
					}
					chevron={!showingWorkspace}
					onClick={() => setShowingWorkspace((showing) => !showing)}
				/>
			</SettingsGroup>
			{error && <Alert>{failureMessage(error)}</Alert>}
		</>
	);
}
