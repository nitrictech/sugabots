import type { Device, LocalAgent } from "@sugabots/contracts";
import { useState } from "react";
import { useDevices, useForgetDevice, useStopLending, useThisDevice } from "@/lib/devices.ts";
import { failureMessage } from "@/lib/failure.ts";
import { LendAgentRow } from "@/shell/LendAgentRow.tsx";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import { SettingsGroup, SettingsRow } from "@/ui/settings-page.tsx";

/**
 * The computers paired to you through the desktop app, each as a group: is
 * it connected, the agents it lends, and unpairing it. Connecting and
 * stopping agents is only offered for the computer this page is open on, in
 * its desktop app, which asks for the folder there; anywhere else they're
 * listed as they are. Not drawn until there is one, since pairing starts in
 * the desktop app.
 */
export function DevicesSettings() {
	const devices = useDevices();
	const thisDevice = useThisDevice();
	const forget = useForgetDevice();
	const stopLending = useStopLending();
	const [forgetting, setForgetting] = useState<Device>();
	if (!devices.data || devices.data.length === 0) return null;

	return (
		<>
			{devices.data.map((device) => {
				const here = device.id === thisDevice;
				return (
					<SettingsGroup
						key={device.id}
						label={here ? `${device.name} (this computer)` : device.name}
						note={
							device.agents === null
								? "Offline: the desktop app isn't running there. Its agents come back when it is."
								: here
									? "Bots standing for these agents run them on this computer, in their folder."
									: "Agents are connected from the Sugabots desktop app on that computer."
						}
					>
						<SettingsRow
							label={device.agents === null ? "Offline" : "Connected"}
							sub="Paired through the Sugabots desktop app"
							trailing={
								<Button variant="destructive" size="sm" onClick={() => setForgetting(device)}>
									Unpair
								</Button>
							}
						/>
						{device.agents?.lent.map((agent) => (
							<LentAgentRow
								key={agent.url}
								agent={agent}
								stop={
									here
										? {
												pending: stopLending.isPending && stopLending.variables?.url === agent.url,
												run: () => stopLending.mutate({ deviceId: device.id, url: agent.url }),
											}
										: undefined
								}
							/>
						))}
						{here &&
							device.agents?.installed.map((installed) => (
								<LendAgentRow key={installed.kind} device={device} installed={installed} />
							))}
					</SettingsGroup>
				);
			})}
			{stopLending.isError && <Alert>{failureMessage(stopLending.error)}</Alert>}
			<DeleteDialog
				open={forgetting !== undefined}
				onOpenChange={(open) => {
					if (!open) setForgetting(undefined);
				}}
				title={`Unpair ${forgetting?.name ?? "this computer"}?`}
				description="Bots standing for its agents stop reaching them. Pair it again from the desktop app to bring them back."
				confirmLabel="Unpair"
				pending={forget.isPending}
				error={forget.error ? failureMessage(forget.error) : undefined}
				onDelete={async () => {
					if (!forgetting) return;
					await forget.mutateAsync(forgetting.id);
					setForgetting(undefined);
				}}
			/>
		</>
	);
}

/**
 * An agent a computer lends, and, on that computer, stopping it: bots
 * standing for it stop reaching it.
 */
function LentAgentRow({
	agent,
	stop,
}: {
	agent: LocalAgent;
	stop: { pending: boolean; run: () => void } | undefined;
}) {
	return (
		<SettingsRow
			label={agent.name}
			sub={agent.workingDirectory}
			trailing={
				stop && (
					<Button variant="secondary" size="sm" disabled={stop.pending} onClick={stop.run}>
						Stop lending
					</Button>
				)
			}
		/>
	);
}
