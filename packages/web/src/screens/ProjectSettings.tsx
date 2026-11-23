import {
	PROJECT_DESCRIPTION_MAX_LENGTH,
	PROJECT_NAME_MAX_LENGTH,
	type Project,
	type ProjectMember,
	workspaceRoleLabel,
} from "@sugabots/contracts";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { Minus } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useBots } from "@/lib/bots.ts";
import { failureMessage } from "@/lib/failure.ts";
import { botSettingsLink, projectBotsLink, projectPeopleLink, projectsLink } from "@/lib/links.ts";
import { countOf } from "@/lib/name-list.ts";
import { projectHeadcount } from "@/lib/project-headcount.ts";
import {
	useDeleteProject,
	useLeaveProject,
	usePlaceProjectBot,
	usePlaceProjectMember,
	useProjectBots,
	useProjectMembers,
	useUpdateProject,
} from "@/lib/projects.ts";
import { useSession } from "@/lib/session.ts";
import { useWorkspaceMembers } from "@/lib/workspace.ts";
import { BotAvatar } from "@/shell/Bot.tsx";
import { OwnerCrumb, OwnerPageCrumb } from "@/shell/BotCrumb.tsx";
import { LeadBotPicker } from "@/shell/LeadBotPicker.tsx";
import { ProjectColourPicker } from "@/shell/LookPicker.tsx";
import { Page } from "@/shell/Page.tsx";
import { ProjectInitial } from "@/shell/SidebarProject.tsx";
import { Alert } from "@/ui/alert.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";
import { useLeave } from "@/ui/back-button.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import {
	SettingsAddButton,
	SettingsControlRow,
	SettingsDanger,
	SettingsGroup,
	SettingsNameRow,
	SettingsPage,
	SettingsRow,
	SettingsRowAlert,
	SettingsValue,
} from "@/ui/settings-page.tsx";
import { Toggle } from "@/ui/toggle.tsx";

/** Which of a project's settings pages is open: its own, its people, or its bots. */
export type ProjectSettingsSection = "general" | "people" | "bots";

/** The title of each of a project's settings pages. */
const SECTION_TITLES = {
	general: "Settings",
	people: "People",
	bots: "Bots",
} as const satisfies Record<ProjectSettingsSection, string>;

/**
 * One project's settings, as pages of its own beside its threads: its own,
 * its lead bot among them, with its people and its bots each a page under
 * it. Its computer and connections are pages of the project's own. Only
 * public bots can be added, and a bot made private leaves its projects,
 * unless it leads one.
 */
export function ProjectSettingsPage({
	project,
	section,
}: {
	project: Project;
	section: ProjectSettingsSection;
}) {
	const owner = { project };
	const title = SECTION_TITLES[section];
	return (
		<Page
			title={title}
			label={section === "general" ? title : `${project.name}'s ${title.toLowerCase()}`}
			parent={
				section === "general" ? (
					<OwnerCrumb owner={owner} />
				) : (
					<OwnerPageCrumb owner={owner} page="settings" />
				)
			}
			place={
				section === "general"
					? { kind: "owner", owner }
					: { kind: "owner", owner, under: "settings" }
			}
		>
			<ProjectSettingsSectionContent key={project.id} project={project} section={section} />
		</Page>
	);
}

function ProjectSettingsSectionContent({
	project,
	section,
}: {
	project: Project;
	section: ProjectSettingsSection;
}) {
	switch (section) {
		case "people":
			return (
				<SettingsPage
					description={`Who is in ${project.name}.`}
					headerAction={project.permissions.manageMembers && <AddPeopleButton project={project} />}
				>
					<Members project={project} />
				</SettingsPage>
			);
		case "bots":
			return <ProjectBots project={project} />;
		case "general":
			return <ProjectDetails project={project} />;
	}
}

function ProjectDetails({ project }: { project: Project }) {
	const may = project.permissions;
	// Three mutations, so a failed rename is said under the name, and a failed change to the
	// lead bot or to the other details (description, visibility, colour) above the page.
	const rename = useUpdateProject(project.id);
	const updateDetails = useUpdateProject(project.id);
	const relead = useUpdateProject(project.id);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const remove = useDeleteProject();
	const router = useRouter();
	const { leaveForPage } = useLeave();

	async function deleteProject() {
		try {
			await remove.mutateAsync(project.id);
		} catch {
			return;
		}
		// Back to the projects, or the projects in the deleted one's place, so Back never returns to it.
		leaveForPage(router.buildLocation(projectsLink()).href);
	}

	const headcount = projectHeadcount({ people: project.memberCount, bots: project.botCount });

	return (
		<SettingsPage
			hero={<ProjectInitial project={project} size="lg" />}
			title={project.name}
			description={headcount}
		>
			{updateDetails.error && <Alert>{failureMessage(updateDetails.error)}</Alert>}
			{relead.error && <Alert>{failureMessage(relead.error)}</Alert>}
			{may.rename && (
				<SettingsGroup
					label="Lead bot"
					note="Answers the project's threads unless people mention another bot, and reads those that mention only people."
				>
					<SettingsControlRow label="Lead bot">
						<LeadBotPicker
							value={project.leadBotId}
							disabled={relead.isPending}
							onChange={(leadBotId) => void relead.mutateAsync({ leadBotId }).catch(() => {})}
						/>
					</SettingsControlRow>
				</SettingsGroup>
			)}
			<SettingsGroup>
				<SettingsRow
					label="People"
					trailing={<SettingsValue>{project.memberCount}</SettingsValue>}
					chevron
					render={<Link {...projectPeopleLink(project)} />}
				/>
				<SettingsRow
					label="Bots"
					trailing={<SettingsValue>{project.botCount}</SettingsValue>}
					chevron
					render={<Link {...projectBotsLink(project)} />}
				/>
			</SettingsGroup>
			{may.rename && (
				<SettingsGroup label="Project">
					<SettingsNameRow
						name={project.name}
						maxLength={PROJECT_NAME_MAX_LENGTH}
						savePending={rename.isPending}
						error={rename.error ? failureMessage(rename.error) : undefined}
						onCommit={(name) => rename.mutateAsync({ name })}
					/>
					<SettingsNameRow
						label="Description"
						name={project.description ?? ""}
						maxLength={PROJECT_DESCRIPTION_MAX_LENGTH}
						optional
						savePending={updateDetails.isPending}
						onCommit={(description) =>
							updateDetails.mutateAsync({ description: description || null })
						}
					/>
					<SettingsRow
						label="Public"
						sub={
							project.visibility === "public"
								? "Listed for everyone in the workspace to join"
								: "Only people added to it can see it"
						}
						trailing={
							<Toggle
								checked={project.visibility === "public"}
								disabled={updateDetails.isPending}
								label={project.visibility === "public" ? "Make private" : "Make public"}
								onChange={(on) =>
									void updateDetails
										.mutateAsync({ visibility: on ? "public" : "private" })
										.catch(() => {})
								}
							/>
						}
					/>
				</SettingsGroup>
			)}
			{may.rename && (
				<SettingsGroup label="Look" note="Shown on the project's icon in the sidebar.">
					<SettingsControlRow label="Colour">
						<ProjectColourPicker
							value={project.color}
							onChange={(color) => void updateDetails.mutateAsync({ color }).catch(() => {})}
						/>
					</SettingsControlRow>
				</SettingsGroup>
			)}
			{may.delete && (
				<SettingsDanger
					label="Delete project"
					description="Removes its threads and files."
					action="Delete"
					onClick={() => setConfirmingDelete(true)}
				/>
			)}
			<DeleteDialog
				open={confirmingDelete}
				onOpenChange={setConfirmingDelete}
				title={`Delete ${project.name}?`}
				description="Its threads and files will be deleted. This can't be undone."
				pending={remove.isPending}
				error={remove.error ? failureMessage(remove.error) : undefined}
				onDelete={deleteProject}
			/>
		</SettingsPage>
	);
}

/**
 * The bots added to the project, which answer there when mentioned, with
 * adding another public bot and taking one out for whoever may. The lead bot
 * stays until another is chosen.
 */
function ProjectBots({ project }: { project: Project }) {
	const bots = useProjectBots(project.id);
	const { bots: workspaceBots } = useBots();
	const place = usePlaceProjectBot(project.id);
	const may = project.permissions.manageBots;
	const inProject = new Set(bots.data?.map((bot) => bot.id));
	const addable =
		workspaceBots?.filter(
			(bot) => bot.visibility === "public" && !bot.assistant && !inProject.has(bot.id),
		) ?? [];
	const count = bots.data?.length ?? 0;
	return (
		<SettingsPage
			description={`${countOf(count, "bot", "bots")} in ${project.name}`}
			headerAction={
				may && (
					<DropdownMenu>
						<SettingsAddButton disabled={place.isPending} render={<DropdownMenuTrigger />}>
							Add bot
						</SettingsAddButton>
						<DropdownMenuContent align="end" className="min-w-52">
							{addable.length === 0 ? (
								<DropdownMenuItem disabled>Every public bot is here.</DropdownMenuItem>
							) : (
								addable.map((bot) => (
									<DropdownMenuItem
										key={bot.id}
										onClick={() => place.mutate({ botId: bot.id, added: true })}
									>
										<span aria-hidden>
											<BotAvatar color={bot.color} face={bot.face} shape={bot.shape} size={22} />
										</span>
										<span className="min-w-0 flex-1 truncate">{bot.name}</span>
									</DropdownMenuItem>
								))
							)}
						</DropdownMenuContent>
					</DropdownMenu>
				)
			}
		>
			{place.error && <Alert>{failureMessage(place.error)}</Alert>}
			<SettingsGroup>
				{count === 0 && (
					<SettingsRow
						label={<span className="text-muted-foreground">No bots in this project yet</span>}
					/>
				)}
				{bots.data?.map((bot) => (
					<SettingsRow
						key={bot.id}
						icon={<BotAvatar color={bot.color} face={bot.face} shape={bot.shape} size={24} />}
						// The name opens the bot's settings and Remove sits beside it, so no button is inside a link.
						label={
							<Link {...botSettingsLink(bot)} className="focus-ring rounded-sm hover:underline">
								{bot.name}
							</Link>
						}
						sub={bot.id === project.leadBotId ? "Lead bot" : bot.description || undefined}
						trailing={
							may &&
							bot.id !== project.leadBotId && (
								<IconButton
									variant="destructive"
									label={`Remove ${bot.name}`}
									disabled={place.isPending}
									onClick={() => place.mutate({ botId: bot.id, added: false })}
								>
									<Minus size={13} strokeWidth={2.6} />
								</IconButton>
							)
						}
					/>
				))}
			</SettingsGroup>
		</SettingsPage>
	);
}

/*
 * The people in the project. Anyone in the workspace can be added; the label
 * after a name is their standing in the workspace, since a project has no
 * roles of its own. Administrators are in every project, so who can be taken
 * out, and whether you may leave, is the API's answer.
 */
function Members({ project }: { project: Project }) {
	const members = useProjectMembers(project.id);
	const workspaceMembers = useWorkspaceMembers(project.workspaceId);
	const remove = usePlaceProjectMember(project.id);
	const leave = useLeaveProject(project.id);
	const navigate = useNavigate();
	const [removing, setRemoving] = useState<ProjectMember>();
	const session = useSession();
	const roleOf = (userId: string) =>
		workspaceMembers.data?.find((member) => member.user.id === userId)?.role;
	const isYou = (userId: string) => userId === session.user?.id;
	const mayTakeOut = (member: ProjectMember) =>
		isYou(member.userId)
			? project.permissions.leave
			: project.permissions.manageMembers && member.removable;
	const leaving = removing !== undefined && isYou(removing.userId);
	const pending = leaving ? leave : remove;

	async function takeOut(member: ProjectMember) {
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
		if (isLeaving) await navigate(projectsLink());
	}

	let rows: ReactNode;
	if (members.isError) {
		rows = <SettingsRowAlert>{failureMessage(members.error)}</SettingsRowAlert>;
	} else if (members.data?.length === 0) {
		rows = <SettingsRow label="Nobody is in this project yet" />;
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
							<IconButton
								variant="destructive"
								label={isYou(member.userId) ? `Leave ${project.name}` : `Remove ${member.name}`}
								disabled={remove.isPending || leave.isPending}
								onClick={() => setRemoving(member)}
							>
								<Minus size={13} strokeWidth={2.6} />
							</IconButton>
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
						? `Leave ${project.name}?`
						: `Remove ${removing?.name ?? "this person"} from ${project.name}?`
				}
				description={
					leaving
						? "You leave its threads. If it's public, you can join again."
						: "They leave its threads. You can add them back at any time."
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
 * aren't in the project yet, each added as they are picked. Why an add failed is
 * said under the button.
 */
function AddPeopleButton({ project }: { project: Project }) {
	const members = useProjectMembers(project.id);
	const workspaceMembers = useWorkspaceMembers(project.workspaceId);
	const invite = usePlaceProjectMember(project.id);
	const inProject = new Set(members.data?.map((member) => member.userId));
	const invitable = workspaceMembers.data?.filter((member) => !inProject.has(member.user.id)) ?? [];
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
