import type { A2AEndpointInput } from "@sugabots/contracts";
import { SegmentedControl } from "@/ui/segmented-control.tsx";
import { SettingsControlRow, SettingsFieldRow, SettingsGroup } from "@/ui/settings-page.tsx";

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

/** An A2A agent's address and secret as somebody types them. */
export interface A2ADraft {
	url: string;
	secretHeader: string;
	secret: string;
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
	return { url, ...(secretHeader ? { secretHeader } : {}), ...(secret ? { secret } : {}) };
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
		</>
	);
}
