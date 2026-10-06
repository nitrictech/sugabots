import type { PodSandbox } from "@sugabots/contracts";
import { useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { formatListTime } from "@/lib/list-time.ts";
import { usePodSandbox, usePodSandboxActions } from "@/lib/pod-sandbox.ts";
import { Alert } from "@/ui/alert.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import { SettingsGroup, SettingsRow, SettingsValue } from "@/ui/settings-page.tsx";
import { PodSandboxNetworkSettings } from "./PodSandboxNetwork.tsx";
import { PodSandboxSoftwareSettings } from "./PodSandboxSoftware.tsx";

/*
 * The pod's sandbox, experimental: how it stands for anyone who can see the
 * pod, starting it afresh or moving its work to the current image for those
 * who may change the pod, and the hosts it may reach. Hidden while the
 * workspace has no sandboxes.
 */
export function PodSandboxSettings({
	podId,
	canManageSandbox,
}: {
	podId: string;
	/** Whether the person may change what the pod's sandbox reaches and has installed. */
	canManageSandbox: boolean;
}) {
	const sandbox = usePodSandbox(podId);
	if (sandbox.isPending) return null;
	if (sandbox.isError) return <Alert>{failureMessage(sandbox.error)}</Alert>;
	const shown = sandbox.data;
	if (!shown.providerEnabled && shown.sandbox.kind === "none") return null;
	return (
		<>
			<SandboxGroup podId={podId} shown={shown} />
			<PodSandboxNetworkSettings podId={podId} canManage={canManageSandbox} />
			<PodSandboxSoftwareSettings podId={podId} canManage={canManageSandbox} />
		</>
	);
}

const STATE_WORDS = {
	running: "Running",
	paused: "Paused",
	lost: "Lost",
	unreachable: "Not answering",
} as const;

function SandboxGroup({ podId, shown }: { podId: string; shown: PodSandbox }) {
	const actions = usePodSandboxActions(podId);
	const [confirm, setConfirm] = useState<"reset" | "upgrade">();
	const { sandbox, canManage } = shown;
	const pending = actions.reset.isPending || actions.upgrade.isPending;
	const failure = actions.reset.error ?? actions.upgrade.error;

	if (sandbox.kind === "none") {
		return (
			<SettingsGroup label="Sandbox">
				<SettingsRow
					label="No sandbox yet"
					sub="One is made the first time a bot here runs a command or uses its browser."
				/>
			</SettingsGroup>
		);
	}

	const now = new Date();
	const busy = [
		sandbox.turnsUsing > 0 &&
			`${sandbox.turnsUsing === 1 ? "A bot is" : `${sandbox.turnsUsing} bots are`} using it`,
		sandbox.peopleWatching > 0 &&
			`${sandbox.peopleWatching === 1 ? "1 person" : `${sandbox.peopleWatching} people`} watching`,
	].filter(Boolean);
	const inUse = sandbox.turnsUsing > 0;

	return (
		<SettingsGroup
			label="Sandbox"
			note={failure ? failureMessage(failure) : stateNote(sandbox.state)}
		>
			<SettingsRow
				label={sandbox.providerName}
				sub={sandbox.image ?? "Image unknown"}
				trailing={<SettingsValue>{STATE_WORDS[sandbox.state]}</SettingsValue>}
			/>
			<SettingsRow
				label="Activity"
				sub={
					busy.length > 0
						? busy.join(", ")
						: `Last used ${formatListTime(new Date(sandbox.lastUsedAt), now).toLowerCase()}`
				}
				trailing={
					<SettingsValue>
						Made {formatListTime(new Date(sandbox.createdAt), now).toLowerCase()}
					</SettingsValue>
				}
			/>
			{canManage && (
				<>
					<SettingsRow
						label={sandbox.upgradeAvailable ? "Upgrade available" : "Upgrade"}
						sub="Moves the pod's work to a new sandbox made from the current image."
						onClick={pending || inUse ? undefined : () => setConfirm("upgrade")}
					/>
					<SettingsRow
						label="Reset"
						sub="Throws the sandbox away. The next one starts empty."
						onClick={pending || inUse ? undefined : () => setConfirm("reset")}
					/>
				</>
			)}
			<DeleteDialog
				open={confirm === "upgrade"}
				onOpenChange={(open) => setConfirm(open ? "upgrade" : undefined)}
				title="Upgrade the sandbox?"
				description="Its workspace, every thread's folder and every bot's home, moves to a new sandbox made from the current image. Running programs and open browser tabs are lost."
				confirmLabel="Upgrade"
				pending={actions.upgrade.isPending}
				error={actions.upgrade.error ? failureMessage(actions.upgrade.error) : undefined}
				onDelete={async () => {
					await actions.upgrade.mutateAsync();
					setConfirm(undefined);
				}}
			/>
			<DeleteDialog
				open={confirm === "reset"}
				onOpenChange={(open) => setConfirm(open ? "reset" : undefined)}
				title="Reset the sandbox?"
				description="Everything in it is deleted: every thread's folder, every bot's home, and any work that wasn't pushed. This can't be undone."
				confirmLabel="Reset"
				pending={actions.reset.isPending}
				error={actions.reset.error ? failureMessage(actions.reset.error) : undefined}
				onDelete={async () => {
					await actions.reset.mutateAsync();
					setConfirm(undefined);
				}}
			/>
		</SettingsGroup>
	);
}

function stateNote(state: keyof typeof STATE_WORDS): string | undefined {
	switch (state) {
		case "paused":
			return "Paused while nobody uses it. It wakes when a bot next needs it.";
		case "lost":
			return "The provider no longer has this sandbox. A new one is made when a bot next needs it.";
		case "unreachable":
			return "The sandbox provider isn't answering, so this may be out of date.";
		case "running":
			return undefined;
	}
}
