import type { A2AEndpointInput, Device, LocalAgent } from "@sugabots/contracts";
import { Check } from "lucide-react";
import { useDevices, useThisDevice } from "@/lib/devices.ts";
import { failureMessage } from "@/lib/failure.ts";
import { Alert } from "@/ui/alert.tsx";
import { Note } from "@/ui/note.tsx";
import { SegmentedControl } from "@/ui/segmented-control.tsx";
import {
	SettingsChoiceRow,
	SettingsControlRow,
	SettingsFieldRow,
	SettingsGroup,
	SettingsRow,
	SettingsValue,
} from "@/ui/settings-page.tsx";
import { LendAgentRow } from "./LendAgentRow.tsx";

/** What answers as a bot: one of the workspace's models, or an external agent another service runs, over A2A. */
export type RunsOn = "model" | "a2a";

const RUNS_ON_OPTIONS = [
	{ value: "model", label: "Model" },
	{ value: "a2a", label: "External agent" },
] as const satisfies readonly { value: RunsOn; label: string }[];

/** The choice of what answers as a bot, as a row of its own. */
export function RunsOnControl({
	value,
	onChange,
}: {
	value: RunsOn;
	onChange: (value: RunsOn) => void;
}) {
	return (
		<SettingsControlRow label="Runs on">
			<SegmentedControl
				label="Runs on"
				options={RUNS_ON_OPTIONS}
				value={value}
				onChange={onChange}
			/>
		</SettingsControlRow>
	);
}

/**
 * Where an external agent is: at an address the server reaches, or on the
 * computer this page is open on, which carries its requests. The second is
 * offered only in the Sugabots desktop app ({@link useThisDevice}).
 */
export type A2APlace = "address" | "device";

const A2A_PLACE_OPTIONS = [
	{ value: "address", label: "At an address" },
	{ value: "device", label: "On my computer" },
] as const satisfies readonly { value: A2APlace; label: string }[];

/** The choice of where the external agent is, as a row of its own. */
export function A2APlaceControl({
	value,
	onChange,
}: {
	value: A2APlace;
	onChange: (value: A2APlace) => void;
}) {
	return (
		<SettingsChoiceRow
			label="Where"
			options={A2A_PLACE_OPTIONS}
			value={value}
			onChange={onChange}
		/>
	);
}

/**
 * An A2A agent's address and secret as somebody types them, and, for one on
 * a computer, the device that lends it, with `url` its address there.
 */
export interface A2ADraft {
	url: string;
	secretHeader: string;
	secret: string;
	deviceId?: string;
}

export const emptyA2ADraft: A2ADraft = { url: "", secretHeader: "", secret: "" };

/**
 * The draft as the API takes it, or nothing while it can't be saved: it has
 * no address, or a secret with no header to send it in.
 */
export function a2aEndpointOf(draft: A2ADraft): A2AEndpointInput | undefined {
	const url = draft.url.trim();
	const secretHeader = draft.secretHeader.trim();
	const secret = draft.secret.trim();
	if (url === "" || (secret !== "" && secretHeader === "")) return undefined;
	return {
		url,
		...(draft.deviceId ? { deviceId: draft.deviceId } : {}),
		...(secretHeader ? { secretHeader } : {}),
		...(secret ? { secret } : {}),
	};
}

/**
 * Where an A2A agent is reached: the address its agent card is under, and the
 * header and secret its service expects, if any. `onLeave` is told when focus
 * leaves the address or the secret, which is when a lookup has something new
 * to check.
 */
export function A2AEndpointFields({
	draft,
	onChange,
	keepsSecret = false,
	onLeave,
}: {
	draft: A2ADraft;
	onChange: (draft: A2ADraft) => void;
	/** Whether a secret is already saved, which an empty field keeps. */
	keepsSecret?: boolean;
	onLeave?: () => void;
}) {
	return (
		<>
			<SettingsGroup note="Where its agent card is: the address it sits under at /.well-known/agent-card.json, or the card's own address.">
				<SettingsFieldRow
					label="Address"
					value={draft.url}
					onChange={(url) => onChange({ ...draft, url })}
					onBlur={onLeave}
					placeholder="https://agents.example.com"
					mono
				/>
			</SettingsGroup>
			<A2ASecretFields
				draft={draft}
				onChange={onChange}
				keepsSecret={keepsSecret}
				onLeave={onLeave}
			/>
		</>
	);
}

/** The header and secret an A2A agent's service expects, if it asks for one. */
export function A2ASecretFields({
	draft,
	onChange,
	keepsSecret = false,
	onLeave,
}: {
	draft: A2ADraft;
	onChange: (draft: A2ADraft) => void;
	keepsSecret?: boolean;
	onLeave?: () => void;
}) {
	return (
		<SettingsGroup note="Only if its service asks for one. Authorization is the usual header.">
			<SettingsFieldRow
				label="Header name"
				value={draft.secretHeader}
				onChange={(secretHeader) => onChange({ ...draft, secretHeader })}
				placeholder="Authorization"
				mono
			/>
			<SettingsFieldRow
				label="Secret"
				value={draft.secret}
				onChange={(secret) => onChange({ ...draft, secret })}
				onBlur={onLeave}
				placeholder={keepsSecret ? "Saved; type to replace" : "Optional"}
				mono
				secret
			/>
		</SettingsGroup>
	);
}

/** An agent a device lends, as chosen for a bot to stand for. */
export interface DeviceAgentChoice {
	deviceId: string;
	agent: LocalAgent;
}

/**
 * The agents this computer lends, to choose one for a bot to stand for, and
 * the ones it could. Only in the desktop app, and only this computer's: a
 * computer's agents are lent from that computer. Loads the person's devices,
 * then shows {@link DeviceAgentList} with this one.
 */
export function DeviceAgentPicker({
	chosen,
	onChoose,
}: {
	chosen: { deviceId: string; url: string } | undefined;
	onChoose: (choice: DeviceAgentChoice) => void;
}) {
	const devices = useDevices();
	const thisDevice = useThisDevice();
	if (devices.isPending) {
		return (
			<SettingsGroup>
				<SettingsRow label="Looking for your computers…" />
			</SettingsGroup>
		);
	}
	if (devices.isError) {
		return <Alert>{failureMessage(devices.error)}</Alert>;
	}
	const here = devices.data.filter((device) => device.id === thisDevice);
	return <DeviceAgentList devices={here} chosen={chosen} onChoose={onChoose} />;
}

/**
 * Each computer as a group of the agents it lends, any of which can be
 * chosen, and the agent programs found on it, any of which can be lent there
 * in a folder its owner chooses on the computer, then chosen. A computer that
 * isn't connected lends nothing until it is. With none, this computer isn't
 * paired to the signed-in person, so it says how to pair it.
 */
export function DeviceAgentList({
	devices,
	chosen,
	onChoose,
}: {
	devices: readonly Device[];
	chosen: { deviceId: string; url: string } | undefined;
	onChoose: (choice: DeviceAgentChoice) => void;
}) {
	if (devices.length === 0) {
		return (
			<Note>
				This computer isn't paired to you. Choose Pair this computer from the Sugabots desktop app's
				tray menu.
			</Note>
		);
	}
	return (
		<>
			{devices.map((device) => (
				<SettingsGroup
					key={device.id}
					label={device.name}
					note={
						device.agents === null
							? "Offline. Open the desktop app on it to reach its agents."
							: device.agents.lent.length === 0 && device.agents.installed.length === 0
								? "Connected, but no agent the desktop app can run was found on it. Install Claude Code there."
								: undefined
					}
				>
					{device.agents === null ? (
						<SettingsRow label="Offline" trailing={<SettingsValue>Not connected</SettingsValue>} />
					) : (
						device.agents.lent.map((agent) => {
							const selected = chosen?.deviceId === device.id && chosen.url === agent.url;
							return (
								<button
									key={agent.url}
									type="button"
									aria-pressed={selected}
									onClick={() => onChoose({ deviceId: device.id, agent })}
									className="focus-ring flex w-full min-w-0 items-center gap-3 border-border border-b px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-panel"
								>
									<span className="flex min-w-0 flex-1 flex-col gap-px">
										<span className="truncate font-medium text-[14.5px] text-foreground">
											{agent.name}
										</span>
										<span className="truncate font-mono text-[12.5px] text-muted-foreground">
											{agent.workingDirectory}
										</span>
									</span>
									{selected && (
										<Check aria-hidden size={15} strokeWidth={2.8} className="shrink-0 text-link" />
									)}
								</button>
							);
						})
					)}
					{device.agents?.installed.map((installed) => (
						<LendAgentRow
							key={installed.kind}
							device={device}
							installed={installed}
							onLent={(agent) => onChoose({ deviceId: device.id, agent })}
						/>
					))}
				</SettingsGroup>
			))}
		</>
	);
}
