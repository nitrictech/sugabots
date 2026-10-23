import type { Device, InstalledAgent, LocalAgent } from "@sugabots/contracts";
import { isApiFailure } from "@sugabots/sdk";
import { useLendAgent } from "@/lib/devices.ts";
import { failureMessage } from "@/lib/failure.ts";
import { Button } from "@/ui/button.tsx";
import { SettingsRow } from "@/ui/settings-page.tsx";

/**
 * An agent program found on one of your computers, and lending it there in a
 * folder. The folder is chosen on the computer itself, where the desktop app
 * asks, so while that's open the row says where to look. Giving up the wait
 * here leaves the computer's dialog to be answered or closed there.
 */
export function LendAgentRow({
	device,
	installed,
	onLent,
}: {
	device: Device;
	installed: InstalledAgent;
	onLent?: (agent: LocalAgent) => void;
}) {
	const lend = useLendAgent();
	const name = installed.version ? `${installed.name} ${installed.version}` : installed.name;
	return (
		<LendAgentRowView
			name={name}
			deviceName={device.name}
			state={lendState(lend)}
			onLend={() =>
				lend.mutate({ deviceId: device.id, kind: installed.kind }, { onSuccess: onLent })
			}
			onStopWaiting={() => lend.reset()}
		/>
	);
}

/** Where asking a computer to lend stands. */
export type LendState =
	| { kind: "idle" }
	| { kind: "waiting" }
	| { kind: "declined" }
	| { kind: "failed"; message: string };

function lendState(lend: ReturnType<typeof useLendAgent>): LendState {
	if (lend.isPending) return { kind: "waiting" };
	if (!lend.isError) return { kind: "idle" };
	if (isApiFailure(lend.error) && lend.error._tag === "Conflict") return { kind: "declined" };
	return {
		kind: "failed",
		message: failureMessage(lend.error, {
			NotFound: "The desktop app isn't running there right now.",
		}),
	};
}

/** {@link LendAgentRow} as drawn, for each state. */
export function LendAgentRowView({
	name,
	deviceName,
	state,
	onLend,
	onStopWaiting,
}: {
	name: string;
	deviceName: string;
	state: LendState;
	onLend: () => void;
	onStopWaiting: () => void;
}) {
	return (
		<SettingsRow
			label={name}
			sub={subOf(state, deviceName)}
			trailing={
				state.kind === "waiting" ? (
					<Button variant="ghost" size="sm" onClick={onStopWaiting}>
						Stop waiting
					</Button>
				) : (
					<Button variant="secondary" size="sm" onClick={onLend}>
						Connect
					</Button>
				)
			}
		/>
	);
}

function subOf(state: LendState, deviceName: string) {
	switch (state.kind) {
		case "idle":
			return "Found on this computer";
		case "waiting":
			return `Choose the folder on ${deviceName}, where the desktop app is asking.`;
		case "declined":
			return "Not lent.";
		case "failed":
			return state.message;
	}
}
