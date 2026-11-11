import {
	type Agent,
	formatDiskSize,
	type PodSandbox,
	type SandboxDisk,
	type SandboxDiskFolder,
	sandboxDiskLevel,
} from "@sugabots/contracts";
import { useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { formatListTimeInSentence } from "@/lib/list-time.ts";
import { usePodSandbox, usePodSandboxActions } from "@/lib/pod-sandbox.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { Alert } from "@/ui/alert.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import { SettingsGroup, SettingsRow, SettingsValue } from "@/ui/settings-page.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";
import { PodSandboxNetworkSettings } from "./PodSandboxNetwork.tsx";
import { DiskMeter, DiskPercent, diskSummary } from "./SandboxDisk.tsx";
import { formatFullTimestamp } from "./ThreadConversation.tsx";

/*
 * The pod's sandbox, experimental: how it stands for anyone who can see the
 * pod, how full its disk is and what fills it, starting it afresh or moving
 * its work to the current image for those who may change the pod, and the
 * hosts it may reach. Hidden while the workspace has no sandboxes.
 */
export function PodSandboxSettings({
	podId,
	bots,
	canManageNetwork,
}: {
	podId: string;
	/** The pod's bots, whose homes the disk's folders are named by. */
	bots: readonly Agent[];
	/** Whether the person may change the hosts the pod's sandbox reaches. */
	canManageNetwork: boolean;
}) {
	const sandbox = usePodSandbox(podId);
	if (sandbox.isPending) return null;
	if (sandbox.isError) return <Alert>{failureMessage(sandbox.error)}</Alert>;
	const shown = sandbox.data;
	if (!shown.providerEnabled && shown.sandbox.kind === "none") return null;
	return (
		<>
			<SandboxGroup podId={podId} shown={shown} />
			{shown.sandbox.kind === "present" && <DiskGroup disk={shown.sandbox.disk} bots={bots} />}
			<PodSandboxNetworkSettings podId={podId} canManage={canManageNetwork} />
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
			<SettingsGroup label="Computer">
				<SettingsRow
					label="No computer yet"
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
			label="Computer"
			note={failure ? failureMessage(failure) : stateNote(sandbox.state)}
		>
			<SettingsRow
				label={sandbox.providerName}
				sub={
					// Pinned to a digest, an image is one long word.
					sandbox.image ? <span className="break-all">{sandbox.image}</span> : "Image unknown"
				}
				trailing={<SettingsValue>{STATE_WORDS[sandbox.state]}</SettingsValue>}
			/>
			<SettingsRow
				label="Activity"
				sub={
					busy.length > 0
						? busy.join(", ")
						: `Last used ${formatListTimeInSentence(new Date(sandbox.lastUsedAt), now)}`
				}
				trailing={
					<SettingsValue>
						Made {formatListTimeInSentence(new Date(sandbox.createdAt), now)}
					</SettingsValue>
				}
			/>
			{canManage && (
				<>
					<SettingsRow
						label={sandbox.upgradeAvailable ? "Upgrade available" : "Upgrade"}
						sub="Moves its files to a new computer with the latest software."
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
				title="Upgrade the computer?"
				description="The files in its workspace move to a new computer with the latest software. Programs installed outside the workspace are lost, and running programs and open browser tabs are closed."
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

const DISK_NOTES = {
	normal: undefined,
	warning:
		"Nearly full. Bots' commands fail once it fills, for every bot in the pod. Ask them to clear caches and clones they've finished with, or reset the computer.",
	critical:
		"Almost full: commands that install, clone or build are about to fail. Ask a bot to clear what it no longer needs, or reset the computer.",
} as const;

/**
 * How full the sandbox's disk was when last measured, and what of it each
 * bot's home, the threads' folders and /tmp take, largest first, so whoever
 * looks after the pod can see what to clear before it fills.
 */
function DiskGroup({ disk, bots }: { disk: SandboxDisk | null; bots: readonly Agent[] }) {
	if (!disk) {
		return (
			<SettingsGroup label="Disk">
				<SettingsRow
					label="Not measured yet"
					sub="It's measured every few minutes while the computer is on."
				/>
			</SettingsGroup>
		);
	}
	const botById = new Map(bots.map((bot) => [bot.id, bot]));
	return (
		<SettingsGroup label="Disk" note={DISK_NOTES[sandboxDiskLevel(disk)]}>
			<SettingsRow
				label={`${diskSummary(disk)} used`}
				sub={
					<>
						<DiskMeter disk={disk} label="Disk used" />
						Measured{" "}
						<Tooltip label={formatFullTimestamp(disk.measuredAt)} side="top">
							<time dateTime={disk.measuredAt} className="hover:underline">
								{formatListTimeInSentence(new Date(disk.measuredAt), new Date())}
							</time>
						</Tooltip>
					</>
				}
				trailing={<DiskPercent disk={disk} />}
			/>
			{disk.folders?.map((folder) => {
				const agent = folder.kind === "home" ? botById.get(folder.agentId) : undefined;
				return (
					<SettingsRow
						key={folder.kind === "home" ? folder.agentId : folder.kind}
						icon={
							agent && (
								<AgentAvatar color={agent.color} face={agent.face} shape={agent.shape} size={24} />
							)
						}
						label={folderLabel(folder, agent?.name)}
						sub={FOLDER_DESCRIPTIONS[folder.kind]}
						trailing={<SettingsValue>{formatDiskSize(folder.bytes)}</SettingsValue>}
					/>
				);
			})}
			<UnsizedRemainder disk={disk} />
		</SettingsGroup>
	);
}

/** What the folders listed above don't account for, or that they couldn't be sized. */
function UnsizedRemainder({ disk }: { disk: SandboxDisk }) {
	if (disk.folders === null) {
		return (
			<SettingsRow
				label="Folders not sized"
				sub="They couldn't be sized this time, often because there are too many files. They're tried again at the next measurement."
			/>
		);
	}
	const elsewhereBytes =
		disk.usedBytes - disk.folders.reduce((sum, folder) => sum + folder.bytes, 0);
	if (elsewhereBytes <= 0) return null;
	return (
		<SettingsRow
			label="Everything else"
			sub="The system, and programs installed outside the workspace"
			trailing={<SettingsValue>{formatDiskSize(elsewhereBytes)}</SettingsValue>}
		/>
	);
}

const FOLDER_DESCRIPTIONS = {
	home: "Home: its tools, settings and caches, in every thread",
	threads: "Where the bots clone, install and build",
	temporary: "/tmp",
} as const;

function folderLabel(folder: SandboxDiskFolder, agentName: string | undefined) {
	switch (folder.kind) {
		case "home":
			return agentName ?? "A removed bot";
		case "threads":
			return "Thread folders";
		case "temporary":
			return "Temporary files";
	}
}
