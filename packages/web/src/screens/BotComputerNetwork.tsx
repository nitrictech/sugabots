import type { BotComputerNetwork } from "@sugabots/contracts";
import { useState } from "react";
import { useBotComputerNetwork } from "@/lib/bot-computer.ts";
import { failureMessage } from "@/lib/failure.ts";
import { Alert } from "@/ui/alert.tsx";
import { SettingsGroup, SettingsRow } from "@/ui/settings-page.tsx";
import { AddedHostRow, AddHostRow } from "./ComputerNetworkSettings.tsx";

/**
 * What the bot's computer may connect to: the hosts the workspace allows every
 * computer, and the bot's own, added here or by allowing its request in a
 * conversation. `canManage` is whether the person may change the bot's own.
 */
export function BotComputerNetworkSettings({
	botId,
	canManage,
}: {
	botId: string;
	canManage: boolean;
}) {
	const { network, addHost, removeHost } = useBotComputerNetwork(botId);
	if (network.isPending) return null;
	if (network.isError) return <Alert>{failureMessage(network.error)}</Alert>;
	return (
		<ChannelNetworkGroup
			network={network.data}
			canManage={canManage}
			pending={addHost.isPending || removeHost.isPending}
			error={addHost.error ?? removeHost.error ?? undefined}
			onAdd={(host) => addHost.mutateAsync(host)}
			onRemove={(host) => removeHost.mutate(host)}
		/>
	);
}

export function ChannelNetworkGroup({
	network,
	canManage,
	pending,
	error,
	onAdd,
	onRemove,
}: {
	network: BotComputerNetwork;
	canManage: boolean;
	pending: boolean;
	error?: unknown;
	onAdd: (host: string) => Promise<unknown>;
	onRemove: (host: string) => void;
}) {
	const [showingWorkspace, setShowingWorkspace] = useState(false);
	const reachable = network.workspaceHosts.filter((entry) => entry.blockedBy === null);
	if (network.mode === "open") {
		return (
			<SettingsGroup
				label="Network"
				note="The workspace's computers are open. Its admins choose this, and any hosts it blocks, in its computer settings."
			>
				<SettingsRow
					label="Open"
					sub={network.blocking ? "Any host the workspace hasn't blocked" : "Any host"}
				/>
			</SettingsGroup>
		);
	}
	return (
		<>
			<SettingsGroup
				label="Network"
				note={
					canManage
						? "This bot's computer connects to the workspace's hosts and these. When it needs another, it asks in its task, and you can allow it there."
						: "This bot's computer connects to the workspace's hosts and these. When it needs another, it asks in its task, and someone who manages the bot decides."
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
							: `${reachable.length} hosts every computer reaches: GitHub, package registries and the workspace's own`
					}
					chevron={!showingWorkspace}
					onClick={() => setShowingWorkspace((showing) => !showing)}
				/>
			</SettingsGroup>
			{error !== undefined && <Alert>{failureMessage(error)}</Alert>}
		</>
	);
}
