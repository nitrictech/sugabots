import {
	type Bot,
	type ComputerDisk,
	type ComputerDiskFolder,
	computerDiskLevel,
	formatDiskSize,
	type ProjectComputer,
} from "@sugabots/contracts";
import { useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { formatFullTimestamp, formatListTimeInSentence } from "@/lib/list-time.ts";
import { countOf } from "@/lib/name-list.ts";
import { useProjectComputer, useProjectComputerActions } from "@/lib/project-computer.ts";
import {
	type ResourceOwner,
	resourcePermissions,
	resourceProjectId,
} from "@/lib/resource-owner.tsx";
import { BotAvatar } from "@/shell/Bot.tsx";
import { Alert } from "@/ui/alert.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import { SettingsGroup, SettingsRow, SettingsValue } from "@/ui/settings-page.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";
import { DiskMeter, DiskPercent, diskSummary } from "./ComputerDisk.tsx";
import { ProjectComputerNetworkSettings } from "./ProjectComputerNetworkSettings.tsx";

/*
 * A project's computer, a bot's being its default project's, experimental:
 * how it stands for anyone who can see the owner, how full its disk is and
 * what fills it, starting it afresh or moving its work to the current image
 * for those who may manage it, and the hosts it may reach. Hidden while the
 * workspace has no computers.
 */
export function ProjectComputerSettings({
	owner,
	bots,
}: {
	owner: ResourceOwner;
	/** The bots whose homes the disk's folders may be: a bot alone, or a project's bots. */
	bots: readonly Bot[];
}) {
	const projectId = resourceProjectId(owner);
	const computer = useProjectComputer(projectId);
	if (computer.isPending) return null;
	if (computer.isError) return <Alert>{failureMessage(computer.error)}</Alert>;
	const shown = computer.data;
	if (!shown.providerEnabled && shown.computer.kind === "none") return null;
	return (
		<>
			<ComputerGroup owner={owner} shown={shown} />
			{shown.computer.kind === "present" && <DiskGroup disk={shown.computer.disk} bots={bots} />}
			<ProjectComputerNetworkSettings owner={owner} />
		</>
	);
}

const STATE_WORDS = {
	running: "Running",
	asleep: "Asleep",
	lost: "Lost",
	unreachable: "Not answering",
} as const;

function ComputerGroup({ owner, shown }: { owner: ResourceOwner; shown: ProjectComputer }) {
	const actions = useProjectComputerActions(resourceProjectId(owner));
	const [confirm, setConfirm] = useState<"reset" | "upgrade">();
	const { computer } = shown;
	const canManage = resourcePermissions(owner).manageComputer;
	const pending = actions.reset.isPending || actions.upgrade.isPending;
	const failure = actions.reset.error ?? actions.upgrade.error;

	if (computer.kind === "none") {
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
		computer.turnsUsing > 0 &&
			`${computer.turnsUsing === 1 ? "A bot is" : `${computer.turnsUsing} bots are`} using it`,
		computer.membersWatching > 0 &&
			`${countOf(computer.membersWatching, "member", "members")} watching`,
	].filter(Boolean);
	const inUse = computer.turnsUsing > 0;

	return (
		<SettingsGroup
			label="Computer"
			note={failure ? failureMessage(failure) : stateNote(computer.state)}
		>
			<SettingsRow
				label={computer.providerName}
				sub={
					// Pinned to a digest, an image is one long word.
					computer.image ? <span className="break-all">{computer.image}</span> : "Image unknown"
				}
				trailing={<SettingsValue>{STATE_WORDS[computer.state]}</SettingsValue>}
			/>
			<SettingsRow
				label="Activity"
				sub={
					busy.length > 0
						? busy.join(", ")
						: `Last used ${formatListTimeInSentence(new Date(computer.lastUsedAt), now)}`
				}
				trailing={
					<SettingsValue>
						Made {formatListTimeInSentence(new Date(computer.createdAt), now)}
					</SettingsValue>
				}
			/>
			{canManage && (
				<>
					<SettingsRow
						label={computer.upgradeAvailable ? "Upgrade available" : "Upgrade"}
						sub="Moves its files to a new computer with the latest software."
						onClick={pending || inUse ? undefined : () => setConfirm("upgrade")}
					/>
					<SettingsRow
						label="Reset"
						sub="Throws the computer away. The next one starts empty."
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
				title="Reset the computer?"
				description="Everything on it is deleted: every chat's folder, each bot's home, and any work that wasn't pushed. This can't be undone."
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
		case "asleep":
			return "Asleep while nobody uses it. It wakes when a bot next needs it.";
		case "lost":
			return "The provider no longer has this computer. A new one is made when a bot next needs it.";
		case "unreachable":
			return "The computer provider isn't answering, so this may be out of date.";
		case "running":
			return undefined;
	}
}

const DISK_NOTES = {
	normal: undefined,
	warning:
		"Nearly full. Bots' commands fail once it fills. Ask a bot to clear caches and clones it's finished with, or reset the computer.",
	critical:
		"Almost full: commands that install, clone or build are about to fail. Ask a bot to clear what it no longer needs, or reset the computer.",
} as const;

/**
 * How full the computer's disk was when last measured, and what of it each
 * bot's home, the chats' folders and /tmp take, largest first, so whoever
 * looks after the computer can see what to clear before it fills.
 */
function DiskGroup({ disk, bots }: { disk: ComputerDisk | null; bots: readonly Bot[] }) {
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
		<SettingsGroup label="Disk" note={DISK_NOTES[computerDiskLevel(disk)]}>
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
				const bot = folder.kind === "home" ? botById.get(folder.botId) : undefined;
				return (
					<SettingsRow
						key={folder.kind === "home" ? folder.botId : folder.kind}
						icon={
							bot && <BotAvatar color={bot.color} eyes={bot.eyes} shape={bot.shape} size={24} />
						}
						label={folderLabel(folder, bot?.name)}
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
function UnsizedRemainder({ disk }: { disk: ComputerDisk }) {
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
	home: "Home: its tools, settings and caches, in every chat",
	chats: "Where the bots clone, install and build",
	temporary: "/tmp",
} as const;

function folderLabel(folder: ComputerDiskFolder, botName: string | undefined) {
	switch (folder.kind) {
		case "home":
			return botName ?? "A removed bot";
		case "chats":
			return "Chat folders";
		case "temporary":
			return "Temporary files";
	}
}
