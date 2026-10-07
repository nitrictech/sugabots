import type { PodSandboxNetwork } from "@sugabots/contracts";
import { useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { usePodSandboxNetwork } from "@/lib/pod-sandbox.ts";
import { Alert } from "@/ui/alert.tsx";
import { SettingsGroup, SettingsRow } from "@/ui/settings-page.tsx";
import { AddedHostRow, AddHostRow } from "./SandboxNetworkSettings.tsx";

/**
 * What the pod's sandbox may connect to: the hosts the workspace allows every
 * pod, and the pod's own, added here or by allowing a bot's request in a
 * thread. `canManage` is whether the person may change the pod's own.
 */
export function PodSandboxNetworkSettings({
	podId,
	canManage,
}: {
	podId: string;
	canManage: boolean;
}) {
	const { network, addHost, removeHost } = usePodSandboxNetwork(podId);
	if (network.isPending) return null;
	if (network.isError) return <Alert>{failureMessage(network.error)}</Alert>;
	return (
		<PodNetworkGroup
			network={network.data}
			canManage={canManage}
			pending={addHost.isPending || removeHost.isPending}
			error={addHost.error ?? removeHost.error ?? undefined}
			onAdd={(host) => addHost.mutateAsync(host)}
			onRemove={(host) => removeHost.mutate(host)}
		/>
	);
}

export function PodNetworkGroup({
	network,
	canManage,
	pending,
	error,
	onAdd,
	onRemove,
}: {
	network: PodSandboxNetwork;
	canManage: boolean;
	pending: boolean;
	error?: unknown;
	onAdd: (host: string) => Promise<unknown>;
	onRemove: (host: string) => void;
}) {
	const [showingWorkspace, setShowingWorkspace] = useState(false);
	const reachable = network.workspaceHosts.filter((entry) => entry.blockedBy === null);
	return (
		<>
			<SettingsGroup
				label="Network"
				note={
					canManage
						? "The sandbox connects to the workspace's hosts and these. When a bot needs another, it asks in its thread, and you can allow it there."
						: "The sandbox connects to the workspace's hosts and these. When a bot needs another, it asks in its thread, and an admin of this pod decides."
				}
			>
				{network.addedHosts.map((added) => (
					<AddedHostRow
						key={added.host}
						added={added}
						blockedBy={added.blockedBy}
						disabled={pending}
						onRemove={canManage ? () => onRemove(added.host) : undefined}
					/>
				))}
				{canManage && <AddHostRow label="Add host" action="Add" disabled={pending} onAdd={onAdd} />}
				<SettingsRow
					label="From the workspace"
					sub={
						showingWorkspace
							? reachable.map((entry) => entry.host).join(", ")
							: `${reachable.length} hosts every pod reaches: GitHub, package registries and the workspace's own`
					}
					chevron={!showingWorkspace}
					onClick={() => setShowingWorkspace((showing) => !showing)}
				/>
			</SettingsGroup>
			{error !== undefined && <Alert>{failureMessage(error)}</Alert>}
		</>
	);
}
