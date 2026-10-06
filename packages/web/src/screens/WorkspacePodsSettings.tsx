import {
	type Agent,
	POD_NAME_MAX_LENGTH,
	type Pod,
	type PodMember,
	workspaceRoleLabel,
} from "@sugabots/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { LockKeyhole, Minus } from "lucide-react";
import { type ReactNode, useDeferredValue, useState } from "react";
import { useAgents } from "@/lib/agents.ts";
import { useConnections } from "@/lib/connections.ts";
import { failureMessage } from "@/lib/failure.ts";
import { agentSettingsLink, podSettingsLink } from "@/lib/links.ts";
import {
	useDeletePod,
	useLeavePod,
	usePlacePodMember,
	usePodMembers,
	usePods,
	useUpdatePod,
} from "@/lib/pods.ts";
import { useSession } from "@/lib/session.ts";
import { useBackTarget, useBackToHere, useSettingsBack } from "@/lib/settings-back.tsx";
import { useWorkspaceMembers } from "@/lib/workspace.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { PodColourPicker } from "@/shell/LookPicker.tsx";
import { NewAgentDialog } from "@/shell/NewAgent.tsx";
import { NewPodDialog } from "@/shell/NewPod.tsx";
import { PodTile } from "@/shell/PodTile.tsx";
import { Alert } from "@/ui/alert.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import {
	PageBackLink,
	SettingsAddMark,
	SettingsAddRow,
	SettingsControlRow,
	SettingsDanger,
	SettingsGroup,
	SettingsListColumn,
	SettingsListDetail,
	SettingsListRow,
	SettingsNameRow,
	SettingsPage,
	SettingsRow,
	SettingsValue,
} from "@/ui/settings-page.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";
import { ConnectionPage } from "./ConnectionPage.tsx";
import { ConnectionsSettings } from "./ConnectionsSettings.tsx";
import { PodSandboxSettings } from "./PodSandboxSettings.tsx";

/**
 * Every pod you reach, beside the open one: its bots, its people and the
 * connections its bots share. Bots belong to a pod for good, so adding one
 * here makes it in this pod.
 */
export function WorkspacePodsSettings({
	selectedPodId,
	selectedConnectionId,
	connectionSignInError,
	canCreatePods,
}: {
	selectedPodId?: string;
	/** One of the selected pod's connections, open on its own page in place of the pod's. */
	selectedConnectionId?: string;
	connectionSignInError?: string;
	canCreatePods: boolean;
}) {
	const { data: pods, isPending, error } = usePods();
	const { agents } = useAgents();
	const navigate = useNavigate();
	const returnTo = useSettingsBack();
	const [search, setSearch] = useState("");
	const [creating, setCreating] = useState(false);
	const needle = useDeferredValue(search.trim().toLowerCase());
	const ordered = [
		...(pods?.filter((pod) => pod.kind === "shared") ?? []),
		...(pods?.filter((pod) => pod.kind === "personal") ?? []),
	];
	const shown = ordered.filter((pod) => needle === "" || pod.name.toLowerCase().includes(needle));
	// With none chosen, the first pod is open beside the list; on a phone the list comes first.
	const selected = selectedPodId ? pods?.find((pod) => pod.id === selectedPodId) : ordered[0];
	const botsIn = (pod: Pod) =>
		agents?.filter((agent) => agent.podId === pod.id && agent.systemAgentKey === null) ?? [];

	if (isPending) return null;

	return (
		<>
			<SettingsListDetail
				detailOpen={selectedPodId !== undefined}
				listLink={{
					label: "Pods",
					render: <Link from="/$workspace" to="./settings/$section" params={{ section: "pods" }} />,
				}}
				returnTo={returnTo}
				list={
					<SettingsListColumn
						title="Pods"
						newLabel="New pod"
						onNew={canCreatePods ? () => setCreating(true) : undefined}
						search={search}
						onSearch={setSearch}
					>
						{shown.map((pod) => {
							const bots = botsIn(pod).length;
							return (
								<SettingsListRow
									key={pod.id}
									picture={<PodPicture pod={pod} bots={botsIn(pod)} size={36} />}
									label={pod.name}
									sub={`${bots} ${bots === 1 ? "bot" : "bots"}`}
									selected={pod.id === selected?.id && (selectedPodId ? true : "wide")}
									render={<Link {...podSettingsLink(pod)} />}
								/>
							);
						})}
						{error && (
							<li className="px-2.5 py-3">
								<Alert>{failureMessage(error)}</Alert>
							</li>
						)}
					</SettingsListColumn>
				}
				detail={
					selected && selectedConnectionId ? (
						<PodConnection
							key={selectedConnectionId}
							pod={selected}
							connectionId={selectedConnectionId}
						/>
					) : selected ? (
						<PodDetails
							key={selected.id}
							pod={selected}
							bots={botsIn(selected)}
							connectionSignInError={connectionSignInError}
						/>
					) : (
						<div className="grid min-h-80 place-items-center p-6">
							<EmptyState title={selectedPodId ? "No such pod here" : "No pods yet"}>
								{selectedPodId
									? "It may have been removed, or you may no longer have access to it."
									: canCreatePods
										? "Make the first pod for this workspace."
										: "You are not in a pod yet."}
							</EmptyState>
						</div>
					)
				}
			/>
			<Dialog open={creating} onOpenChange={setCreating}>
				<NewPodDialog
					onCreated={async (pod) => {
						setCreating(false);
						await navigate(podSettingsLink(pod));
					}}
				/>
			</Dialog>
		</>
	);
}

/** One of the pod's connections on its own page, with Back to the pod. */
function PodConnection({ pod, connectionId }: { pod: Pod; connectionId: string }) {
	const connections = useConnections(pod.id);
	const back = useBackTarget({ label: pod.name, render: <Link {...podSettingsLink(pod)} /> });
	const connection = connections.data?.find((one) => one.id === connectionId);
	if (connections.isPending) return null;
	if (!connection) {
		return (
			<div className="grid min-h-80 place-items-center p-6">
				<EmptyState
					title={connections.isError ? "Could not load this connection" : "No such connection here"}
				>
					{connections.isError
						? failureMessage(connections.error)
						: "It may have been removed from this pod."}
				</EmptyState>
			</div>
		);
	}
	return <ConnectionPage connection={connection} pod={pod} back={<PageBackLink {...back} />} />;
}

/** A pod as its tile of faces, or Personal as its lock. */
function PodPicture({ pod, bots, size }: { pod: Pod; bots: readonly Agent[]; size: 36 | 88 }) {
	if (pod.kind === "personal") {
		return (
			<span
				aria-hidden
				className="grid shrink-0 place-items-center bg-tile text-soft-foreground"
				style={{ width: size, height: size, borderRadius: size === 88 ? 26 : 11 }}
			>
				<LockKeyhole size={size === 88 ? 34 : 16} strokeWidth={2} />
			</span>
		);
	}
	return <PodTile bots={bots} color={pod.color} size={size} />;
}

function PodDetails({
	pod,
	bots,
	connectionSignInError,
}: {
	pod: Pod;
	bots: readonly Agent[];
	connectionSignInError?: string;
}) {
	const may = pod.permissions;
	// Two mutations, so a failed rename is said under the name and a failed recolour above the page.
	const rename = useUpdatePod(pod.id);
	const recolour = useUpdatePod(pod.id);
	const members = usePodMembers(pod.id);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const remove = useDeletePod();
	const navigate = useNavigate();
	const shared = pod.kind === "shared";
	const people = members.data?.length;

	async function deletePod() {
		try {
			await remove.mutateAsync(pod.id);
		} catch {
			return;
		}
		await navigate({ from: "/$workspace", to: "./settings/$section", params: { section: "pods" } });
	}

	const counts = [
		`${bots.length} ${bots.length === 1 ? "bot" : "bots"}`,
		shared && people !== undefined ? `${people} ${people === 1 ? "person" : "people"}` : undefined,
	].filter(Boolean);

	return (
		<SettingsPage
			hero={<PodPicture pod={pod} bots={bots} size={88} />}
			title={pod.name}
			description={shared ? counts.join(", ") : "Only you can see this pod and its bots."}
		>
			{recolour.error && <Alert>{failureMessage(recolour.error)}</Alert>}
			{may.rename && (
				<SettingsGroup label="Pod">
					<SettingsNameRow
						name={pod.name}
						maxLength={POD_NAME_MAX_LENGTH}
						savePending={rename.isPending}
						error={rename.error ? failureMessage(rename.error) : undefined}
						onCommit={(name) => rename.mutateAsync({ name })}
					/>
				</SettingsGroup>
			)}
			{may.rename && pod.color !== null && (
				<SettingsGroup label="Look">
					<SettingsControlRow label="Colour">
						<PodColourPicker
							value={pod.color}
							onChange={(color) => void recolour.mutateAsync({ color }).catch(() => {})}
						/>
					</SettingsControlRow>
				</SettingsGroup>
			)}
			<ConnectionsSettings
				pod={pod}
				canManage={may.manageConnections}
				signInError={connectionSignInError}
			/>
			<PodSandboxSettings podId={pod.id} canManageSandbox={may.manageSandbox} />
			<PodBots pod={pod} bots={bots} />
			{shared && <Members pod={pod} canManageMembers={may.manageMembers} />}
			{shared && may.rename && (
				<SettingsDanger onClick={() => setConfirmingDelete(true)}>Delete pod</SettingsDanger>
			)}
			<DeleteDialog
				open={confirmingDelete}
				onOpenChange={setConfirmingDelete}
				title={`Delete ${pod.name}?`}
				description="Its bots, their chats, routines and connections will be deleted. This can't be undone."
				pending={remove.isPending}
				error={remove.error ? failureMessage(remove.error) : undefined}
				onDelete={deletePod}
			/>
		</SettingsPage>
	);
}

function PodBots({ pod, bots }: { pod: Pod; bots: readonly Agent[] }) {
	const backToPod = useBackToHere(`${pod.name} pod`);
	const [creating, setCreating] = useState(false);
	const navigate = useNavigate();
	if (bots.length === 0 && !pod.permissions.createAgents) {
		return (
			<SettingsGroup label="Bots">
				<SettingsRow label="No bots in this pod yet" />
			</SettingsGroup>
		);
	}
	return (
		<SettingsGroup label="Bots">
			{bots.map((agent) => (
				<SettingsRow
					key={agent.id}
					icon={<AgentAvatar color={agent.color} face={agent.face} size={30} />}
					label={agent.name}
					chevron
					render={<Link {...agentSettingsLink({ pod, agent })} state={backToPod} />}
				/>
			))}
			{pod.permissions.createAgents && (
				<SettingsAddRow label="New bot" onClick={() => setCreating(true)} />
			)}
			<Dialog open={creating} onOpenChange={setCreating}>
				<NewAgentDialog
					podId={pod.id}
					onCreated={async (agent) => {
						setCreating(false);
						await navigate({ ...agentSettingsLink({ pod, agent }), state: backToPod });
					}}
				/>
			</Dialog>
		</SettingsGroup>
	);
}

/*
 * The people who can see into the pod. Anyone in the workspace can be added;
 * the label after a name is their standing in the workspace, since a pod has
 * no roles of its own. Who can be taken out, and whether you may leave, is
 * the API's answer.
 */
function Members({ pod, canManageMembers }: { pod: Pod; canManageMembers: boolean }) {
	const members = usePodMembers(pod.id);
	const workspaceMembers = useWorkspaceMembers(pod.workspaceId);
	const invite = usePlacePodMember(pod.id);
	const remove = usePlacePodMember(pod.id);
	const leave = useLeavePod(pod.id);
	const navigate = useNavigate();
	const [removing, setRemoving] = useState<PodMember>();
	const session = useSession();
	const inPod = new Set(members.data?.map((member) => member.userId));
	const roleOf = (userId: string) =>
		workspaceMembers.data?.find((member) => member.user.id === userId)?.role;
	const isYou = (userId: string) => userId === session.user?.id;
	const mayTakeOut = (member: PodMember) =>
		isYou(member.userId) ? pod.permissions.leave : canManageMembers && member.removable;
	const leaving = removing !== undefined && isYou(removing.userId);
	const pending = leaving ? leave : remove;
	const invitable = workspaceMembers.data?.filter((member) => !inPod.has(member.user.id)) ?? [];

	async function takeOut(member: PodMember) {
		const isLeaving = isYou(member.userId);
		try {
			if (isLeaving) {
				await leave.mutateAsync();
			} else {
				await remove.mutateAsync({ userId: member.userId, member: false });
			}
		} catch {
			return;
		}
		setRemoving(undefined);
		if (isLeaving) {
			await navigate({
				from: "/$workspace",
				to: "./settings/$section",
				params: { section: "pods" },
			});
		}
	}

	let rows: ReactNode;
	if (members.isError) {
		rows = (
			<div className="px-4 py-3">
				<Alert>{failureMessage(members.error)}</Alert>
			</div>
		);
	} else if (members.data?.length === 0) {
		rows = <SettingsRow label="Nobody can see into this pod yet" />;
	} else {
		rows = members.data?.map((member) => (
			<SettingsRow
				key={member.userId}
				icon={<PersonAvatar person={member} size={30} />}
				label={member.name}
				trailing={
					<>
						<SettingsValue>
							{isYou(member.userId)
								? "You"
								: // Said once the workspace roster has answered, not guessed before it.
									workspaceMembers.data && workspaceRoleLabel(roleOf(member.userId))}
						</SettingsValue>
						{mayTakeOut(member) && (
							<Tooltip label={isYou(member.userId) ? "Leave pod" : "Remove from pod"}>
								<button
									type="button"
									aria-label={isYou(member.userId) ? `Leave ${pod.name}` : `Remove ${member.name}`}
									disabled={remove.isPending || leave.isPending}
									onClick={() => setRemoving(member)}
									className="focus-ring grid size-7 shrink-0 place-items-center rounded-full text-destructive-text transition-colors hover:bg-destructive-hover"
								>
									<Minus size={13} strokeWidth={2.6} />
								</button>
							</Tooltip>
						)}
					</>
				}
			/>
		));
	}

	return (
		<SettingsGroup label="Members">
			{rows}
			{canManageMembers && (
				<DropdownMenu>
					<DropdownMenuTrigger
						disabled={invite.isPending}
						className="focus-ring flex w-full items-center gap-3 border-border border-t px-4 py-2.5 text-left transition-colors hover:bg-panel"
					>
						<SettingsAddMark />
						<span className="font-medium text-[14.5px] text-link">Add people</span>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start" className="min-w-52">
						{workspaceMembers.isPending ? (
							<DropdownMenuItem disabled>Loading…</DropdownMenuItem>
						) : invitable.length === 0 ? (
							<DropdownMenuItem disabled>Everyone in the workspace is here.</DropdownMenuItem>
						) : (
							invitable.map((member) => (
								<DropdownMenuItem
									key={member.user.id}
									onClick={() => invite.mutate({ userId: member.user.id, member: true })}
								>
									{/* Hidden from the name, or the initials would read as part of it. */}
									<span aria-hidden>
										<PersonAvatar person={member.user} size={22} />
									</span>
									<span className="min-w-0 flex-1 truncate">{member.user.name}</span>
								</DropdownMenuItem>
							))
						)}
					</DropdownMenuContent>
				</DropdownMenu>
			)}
			{invite.error && (
				<div className="border-border border-t px-4 py-3">
					<Alert>{failureMessage(invite.error)}</Alert>
				</div>
			)}
			<DeleteDialog
				open={removing !== undefined}
				onOpenChange={(open) => {
					if (!open) setRemoving(undefined);
				}}
				title={
					leaving
						? `Leave ${pod.name}?`
						: `Remove ${removing?.name ?? "this person"} from ${pod.name}?`
				}
				description={
					leaving
						? "You lose this pod, its bots, and your chats. An administrator can add you back."
						: "They lose this pod, its bots, and their chats. You can add them back at any time."
				}
				confirmLabel={leaving ? "Leave" : "Remove"}
				pending={pending.isPending}
				error={pending.error ? failureMessage(pending.error) : undefined}
				onDelete={async () => {
					if (removing) await takeOut(removing);
				}}
			/>
		</SettingsGroup>
	);
}
