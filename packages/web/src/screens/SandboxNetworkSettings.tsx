import type {
	SandboxAddedHost,
	SandboxBlockedHost,
	SandboxNetworkSettings,
} from "@sugabots/contracts";
import { X } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { useSandboxNetwork } from "@/lib/sandbox-providers.ts";
import { Alert } from "@/ui/alert.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { SettingsControlRow, SettingsGroup, SettingsRow } from "@/ui/settings-page.tsx";

/**
 * What every pod's sandbox may connect to: the trusted hosts every workspace
 * has, and the ones this workspace added. Each pod adds its own in its
 * settings. The workspace's blocked hosts are out of every pod's reach.
 */
export function SandboxNetworkSection() {
	const { settings, addHost, removeHost, blockHost, unblockHost } = useSandboxNetwork();
	if (settings.isPending) return null;
	if (settings.isError) return <Alert>{failureMessage(settings.error)}</Alert>;
	const changes = [addHost, removeHost, blockHost, unblockHost];
	return (
		<SandboxNetworkGroups
			settings={settings.data}
			pending={changes.some((change) => change.isPending)}
			error={changes.find((change) => change.error)?.error ?? undefined}
			onAdd={(host) => addHost.mutateAsync(host)}
			onRemove={(host) => removeHost.mutate(host)}
			onBlock={(host) => blockHost.mutateAsync(host)}
			onUnblock={(host) => unblockHost.mutate(host)}
		/>
	);
}

export function SandboxNetworkGroups({
	settings,
	pending,
	error,
	onAdd,
	onRemove,
	onBlock,
	onUnblock,
}: {
	settings: SandboxNetworkSettings;
	pending: boolean;
	error?: unknown;
	onAdd: (host: string) => Promise<unknown>;
	onRemove: (host: string) => void;
	onBlock: (host: string) => Promise<unknown>;
	onUnblock: (host: string) => void;
}) {
	const [showingTrusted, setShowingTrusted] = useState(false);
	return (
		<>
			<SettingsGroup
				label="Network"
				note="Every pod's sandbox connects to these hosts, and each pod adds its own under Sandbox in its settings. When a bot needs another, it asks in its thread, and the pod decides."
			>
				{settings.addedHosts.map((added) => (
					<AddedHostRow
						key={added.host}
						added={added}
						disabled={pending}
						onRemove={() => onRemove(added.host)}
					/>
				))}
				<AddHostRow label="Add host" action="Add" disabled={pending} onAdd={onAdd} />
				<SettingsRow
					label="Trusted hosts"
					sub={
						showingTrusted
							? settings.trustedHosts.join(", ")
							: `${settings.trustedHosts.length} hosts every workspace reaches: GitHub, package registries and Linux mirrors`
					}
					chevron={!showingTrusted}
					onClick={() => setShowingTrusted((showing) => !showing)}
				/>
			</SettingsGroup>
			<SettingsGroup
				label="Blocked hosts"
				note="No pod's sandbox connects to these, whatever it allows, and bots' requests for them are refused. Blocking a host also keeps out any wildcard that covers it."
			>
				{settings.blockedHosts.map((blocked) => (
					<BlockedHostRow
						key={blocked.host}
						blocked={blocked}
						disabled={pending}
						onUnblock={() => onUnblock(blocked.host)}
					/>
				))}
				<AddHostRow label="Block host" action="Block" disabled={pending} onAdd={onBlock} />
			</SettingsGroup>
			{error !== undefined && <Alert>{failureMessage(error)}</Alert>}
		</>
	);
}

/**
 * A host someone added, and who. Without `onRemove` it can't be removed here.
 * `blockedBy` names the workspace's block that keeps it out anyway.
 */
export function AddedHostRow({
	added,
	blockedBy = null,
	disabled,
	onRemove,
}: {
	added: SandboxAddedHost;
	blockedBy?: string | null;
	disabled: boolean;
	onRemove?: () => void;
}) {
	const by = added.addedByName ?? "someone who has left";
	return (
		<SettingsRow
			label={<span className="font-mono text-[13.5px]">{added.host}</span>}
			sub={
				blockedBy ? `Blocked for the workspace by ${blockedBy}. Added by ${by}` : `Added by ${by}`
			}
			trailing={
				onRemove && (
					<IconButton label={`Remove ${added.host}`} disabled={disabled} onClick={onRemove}>
						<X size={16} />
					</IconButton>
				)
			}
		/>
	);
}

function BlockedHostRow({
	blocked,
	disabled,
	onUnblock,
}: {
	blocked: SandboxBlockedHost;
	disabled: boolean;
	onUnblock: () => void;
}) {
	return (
		<SettingsRow
			label={<span className="font-mono text-[13.5px]">{blocked.host}</span>}
			sub={`Blocked by ${blocked.blockedByName ?? "someone who has left"}`}
			trailing={
				<IconButton label={`Unblock ${blocked.host}`} disabled={disabled} onClick={onUnblock}>
					<X size={16} />
				</IconButton>
			}
		/>
	);
}

/** A host to type in, and the button that sends it: `action`, such as Add or Block. */
export function AddHostRow({
	label,
	action,
	disabled,
	onAdd,
}: {
	label: string;
	action: string;
	disabled: boolean;
	onAdd: (host: string) => Promise<unknown>;
}) {
	const id = useId();
	const [draft, setDraft] = useState("");

	function submit(event: FormEvent) {
		event.preventDefault();
		const host = draft.trim().toLowerCase();
		if (!host) return;
		void onAdd(host).then(() => setDraft(""));
	}

	return (
		<form onSubmit={submit}>
			<SettingsControlRow label={label} htmlFor={id}>
				<input
					id={id}
					type="text"
					autoComplete="off"
					spellCheck={false}
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					placeholder="api.example.com or *.example.com"
					className="min-w-0 flex-1 bg-transparent font-mono text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground"
				/>
				<button
					type="submit"
					disabled={disabled || draft.trim() === ""}
					className="focus-ring shrink-0 rounded-md font-medium text-link text-sm disabled:opacity-50"
				>
					{action}
				</button>
			</SettingsControlRow>
		</form>
	);
}
