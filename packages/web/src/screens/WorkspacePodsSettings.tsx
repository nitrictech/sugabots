import {
	type Agent,
	POD_NAME_MAX_LENGTH,
	type Pod,
	type PodMember,
	workspaceRoleLabel,
} from "@sugabots/contracts";
import { Link, linkOptions, useNavigate, useRouter } from "@tanstack/react-router";
import { Minus } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useAgents } from "@/lib/agents.ts";
import { useConnections } from "@/lib/connections.ts";
import { failureMessage } from "@/lib/failure.ts";
import { agentSettingsLink, podSettingsPageLink } from "@/lib/links.ts";
import {
	useDeletePod,
	useLeavePod,
	usePlacePodMember,
	usePodMembers,
	usePods,
	useUpdatePod,
} from "@/lib/pods.ts";
import { useSession } from "@/lib/session.ts";
import { useBackTarget, useBackToHere } from "@/lib/settings-back.tsx";
import { useWorkspaceMembers } from "@/lib/workspace.ts";
import { type PodSettingsPage, podHasSettingsPage } from "@/lib/workspace-settings.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { PodColourPicker } from "@/shell/LookPicker.tsx";
import { NewAgentDialog } from "@/shell/NewAgent.tsx";
import { PodInitial } from "@/shell/SidebarPod.tsx";
import { Alert } from "@/ui/alert.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";
import { useLeave } from "@/ui/back-button.tsx";
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
	SettingsAddButton,
	SettingsControlRow,
	SettingsDanger,
	SettingsGroup,
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
 * One pod's settings, a page at a time as the navigation lists them: General,
 * the connections its bots share, its people, and its bots. Bots belong to a
 * pod for good, so adding one here makes it in this pod.
 */
export function WorkspacePodsSettings({
	selectedPodId,
	podPage = "general",
	selectedConnectionId,
	connectionSignInError,
	canCreatePods,
}: {
	selectedPodId?: string;
	podPage?: PodSettingsPage;
	/** One of the selected pod's connections, open on its own page in place of the pod's. */
	selectedConnectionId?: string;
	connectionSignInError?: string;
	canCreatePods: boolean;
}) {
	const { data: pods, isPending, error } = usePods();
	const { agents } = useAgents();
	// With none chosen, the first shared pod is open, as the navigation lists them.
	const selected = selectedPodId
		? pods?.find((pod) => pod.id === selectedPodId)
		: (pods?.find((pod) => pod.kind === "shared") ?? pods?.[0]);
	const bots =
		agents?.filter((agent) => agent.podId === selected?.id && agent.systemAgentKey === null) ?? [];
	// Opened by the buttons beside the pages' titles, and shown by the lists below them.
	const [addingConnection, setAddingConnection] = useState(false);
	const [creatingBot, setCreatingBot] = useState(false);

	if (isPending) return null;
	if (error) {
		return (
			<SettingsPage title="Pods">
				<Alert>{failureMessage(error)}</Alert>
			</SettingsPage>
		);
	}
	if (!selected) {
		return (
			<div className="grid min-h-80 flex-1 place-items-center p-6">
				<EmptyState title={selectedPodId ? "No such pod here" : "No pods yet"}>
					{selectedPodId
						? "It may have been removed, or you may no longer have access to it."
						: canCreatePods
							? "Make the first pod for this workspace."
							: "You are not in a pod yet."}
				</EmptyState>
			</div>
		);
	}
	if (selectedConnectionId) {
		return (
			<PodConnection
				key={selectedConnectionId}
				pod={selected}
				connectionId={selectedConnectionId}
			/>
		);
	}
	// A page the pod doesn't have, such as a personal pod's General, gives way to its Connections.
	switch (podHasSettingsPage(selected, podPage) ? podPage : "connections") {
		case "connections":
			return (
				<SettingsPage
					key={selected.id}
					title="Connections"
					description={`Shared by every bot in ${selected.name}.`}
					headerAction={
						selected.permissions.manageConnections && (
							<SettingsAddButton onClick={() => setAddingConnection(true)}>
								Add connection
							</SettingsAddButton>
						)
					}
				>
					<ConnectionsSettings
						pod={selected}
						canManage={selected.permissions.manageConnections}
						signInError={connectionSignInError}
						adding={addingConnection}
						onAddingChange={setAddingConnection}
					/>
				</SettingsPage>
			);
		case "people":
			return (
				<SettingsPage
					key={selected.id}
					title="People"
					description={`Who can see ${selected.name} and talk to its bots.`}
					headerAction={selected.permissions.manageMembers && <AddPeopleButton pod={selected} />}
				>
					<Members pod={selected} canManageMembers={selected.permissions.manageMembers} />
				</SettingsPage>
			);
		case "bots":
			return (
				<SettingsPage
					key={selected.id}
					title="Bots"
					description={`${bots.length} ${bots.length === 1 ? "bot" : "bots"} in ${selected.name}`}
					headerAction={
						selected.permissions.createAgents && (
							<SettingsAddButton onClick={() => setCreatingBot(true)}>New bot</SettingsAddButton>
						)
					}
				>
					<PodBots
						pod={selected}
						bots={bots}
						creating={creatingBot}
						onCreatingChange={setCreatingBot}
					/>
				</SettingsPage>
			);
		case "computer":
			return (
				<SettingsPage
					key={selected.id}
					title="Computer"
					description={`The computer ${selected.name}'s bots run commands, browse and edit files on. Experimental.`}
				>
					<PodSandboxSettings
						podId={selected.id}
						canManageNetwork={selected.permissions.manageSandbox}
					/>
				</SettingsPage>
			);
		case "general":
			return <PodDetails key={selected.id} pod={selected} bots={bots} />;
	}
}

/** One of the pod's connections on its own page, with Back to the pod's Connections. */
function PodConnection({ pod, connectionId }: { pod: Pod; connectionId: string }) {
	const connections = useConnections(pod.id);
	const back = useBackTarget({
		label: "Connections",
		render: <Link {...podSettingsPageLink(pod, "connections")} />,
	});
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

function PodDetails({ pod, bots }: { pod: Pod; bots: readonly Agent[] }) {
	const may = pod.permissions;
	// Two mutations, so a failed rename is said under the name and a failed recolour above the page.
	const rename = useUpdatePod(pod.id);
	const recolour = useUpdatePod(pod.id);
	const members = usePodMembers(pod.id);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const remove = useDeletePod();
	const router = useRouter();
	const { leaveForPage } = useLeave();
	const shared = pod.kind === "shared";
	const people = members.data?.length;

	async function deletePod() {
		try {
			await remove.mutateAsync(pod.id);
		} catch {
			return;
		}
		// Back to the pods, or the pods in the deleted pod's place, so Back never returns to it.
		leaveForPage(
			router.buildLocation(
				linkOptions({
					from: "/$workspace",
					to: "./settings/$section",
					params: { section: "pods" },
				}),
			).href,
		);
	}

	const counts = [
		`${bots.length} ${bots.length === 1 ? "bot" : "bots"}`,
		shared && people !== undefined ? `${people} ${people === 1 ? "person" : "people"}` : undefined,
	].filter(Boolean);

	return (
		<SettingsPage
			hero={<PodInitial pod={pod} size="lg" />}
			title={pod.name}
			description={counts.join(", ")}
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
				<SettingsGroup label="Look" note="Shown on the pod's icon in the sidebar.">
					<SettingsControlRow label="Colour">
						<PodColourPicker
							value={pod.color}
							onChange={(color) => void recolour.mutateAsync({ color }).catch(() => {})}
						/>
					</SettingsControlRow>
				</SettingsGroup>
			)}
			{shared && may.rename && (
				<SettingsDanger
					label="Delete pod"
					description="Removes its bots, threads and artifacts."
					action="Delete"
					onClick={() => setConfirmingDelete(true)}
				/>
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

function PodBots({
	pod,
	bots,
	creating,
	onCreatingChange,
}: {
	pod: Pod;
	bots: readonly Agent[];
	/** Whether New bot is open, which the page's own button beside its title opens. */
	creating: boolean;
	onCreatingChange: (creating: boolean) => void;
}) {
	const backToPod = useBackToHere("Bots");
	const navigate = useNavigate();
	return (
		<SettingsGroup>
			{bots.length === 0 && (
				<SettingsRow
					label={<span className="text-muted-foreground">No bots in this pod yet</span>}
				/>
			)}
			{bots.map((agent) => (
				<SettingsRow
					key={agent.id}
					icon={<AgentAvatar color={agent.color} face={agent.face} shape={agent.shape} size={24} />}
					label={agent.name}
					sub={agent.description || undefined}
					chevron
					render={<Link {...agentSettingsLink({ pod, agent })} state={backToPod} />}
				/>
			))}
			<Dialog open={creating} onOpenChange={onCreatingChange}>
				<NewAgentDialog
					podId={pod.id}
					onCreated={async (agent) => {
						onCreatingChange(false);
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
	const remove = usePlacePodMember(pod.id);
	const leave = useLeavePod(pod.id);
	const navigate = useNavigate();
	const [removing, setRemoving] = useState<PodMember>();
	const session = useSession();
	const roleOf = (userId: string) =>
		workspaceMembers.data?.find((member) => member.user.id === userId)?.role;
	const isYou = (userId: string) => userId === session.user?.id;
	const mayTakeOut = (member: PodMember) =>
		isYou(member.userId) ? pod.permissions.leave : canManageMembers && member.removable;
	const leaving = removing !== undefined && isYou(removing.userId);
	const pending = leaving ? leave : remove;

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
				icon={<PersonAvatar person={member} size={24} />}
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
		<SettingsGroup>
			{rows}
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

/**
 * Add people, beside the People title: a menu of the workspace's people who
 * aren't in the pod yet, each added as they are picked. Why an add failed is
 * said under the button.
 */
function AddPeopleButton({ pod }: { pod: Pod }) {
	const members = usePodMembers(pod.id);
	const workspaceMembers = useWorkspaceMembers(pod.workspaceId);
	const invite = usePlacePodMember(pod.id);
	const inPod = new Set(members.data?.map((member) => member.userId));
	const invitable = workspaceMembers.data?.filter((member) => !inPod.has(member.user.id)) ?? [];
	return (
		<div className="flex flex-col items-end gap-2">
			<DropdownMenu>
				<SettingsAddButton disabled={invite.isPending} render={<DropdownMenuTrigger />}>
					Add people
				</SettingsAddButton>
				<DropdownMenuContent align="end" className="min-w-52">
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
			{invite.error && <Alert>{failureMessage(invite.error)}</Alert>}
		</div>
	);
}
