import {
	PROJECT_DESCRIPTION_MAX_LENGTH,
	PROJECT_NAME_MAX_LENGTH,
	type Project,
} from "@sugabots/contracts";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { Minus } from "lucide-react";
import { useId, useState } from "react";
import { useBots } from "@/lib/bots.ts";
import { failureMessage } from "@/lib/failure.ts";
import { botSettingsLink, projectBotsLink, projectMembersLink, projectsLink } from "@/lib/links.ts";
import { countOf, listNames } from "@/lib/name-list.ts";
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
import { ProjectColourPicker } from "@/shell/AvatarPicker.tsx";
import { BotAvatar } from "@/shell/Bot.tsx";
import { OwnerCrumb, OwnerPageCrumb } from "@/shell/BotCrumb.tsx";
import { BotMenuItem, canBeInProject, LeadBotPicker } from "@/shell/LeadBotPicker.tsx";
import { Page } from "@/shell/Page.tsx";
import { ProjectInitial } from "@/shell/SidebarProject.tsx";
import { Alert } from "@/ui/alert.tsx";
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
	SettingsValue,
} from "@/ui/settings-page.tsx";
import { Switch } from "@/ui/switch.tsx";
import { AddMembersMenu, MemberRows } from "./MemberList.tsx";

/** Which of a project's settings pages is open: its own, its members, or its bots. */
export type ProjectSettingsSection = "general" | "members" | "bots";

/** The title of each of a project's settings pages. */
const SECTION_TITLES = {
	general: "Settings",
	members: "Members",
	bots: "Bots",
} as const satisfies Record<ProjectSettingsSection, string>;

/**
 * One project's settings, as pages of its own beside its chats: its own,
 * its lead bot among them, with its members and its bots each a page under
 * it. Its computer and connectors are pages of the project's own. Public
 * bots can be added, and private ones to a private project.
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
		case "members":
			return (
				<SettingsPage
					description={`Who is in ${project.name}.`}
					headerAction={project.permissions.manageMembers && <AddMembersButton project={project} />}
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
	// Separate mutations, so a failed rename is said under the name, a failed move to public in
	// its confirmation, and a failed change to the lead bot or to the other details
	// (description, making it private, colour) above the page.
	const rename = useUpdateProject(project.id);
	const updateDetails = useUpdateProject(project.id);
	const relead = useUpdateProject(project.id);
	const makePublic = useUpdateProject(project.id);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const [confirmingPublic, setConfirmingPublic] = useState(false);
	const isPublic = project.visibility === "public";
	// The server refuses to make a project with private bots public, so the switch says so first.
	const privateBotNames = (useProjectBots(project.id).data ?? [])
		.filter((bot) => bot.visibility === "private")
		.map((bot) => bot.name);
	const publicBlocked = !isPublic && privateBotNames.length > 0;
	const visibilitySubId = useId();
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

	const headcount = projectHeadcount({ members: project.memberCount, bots: project.botCount });

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
					note="Answers the project's chats unless members mention another bot, and reads those that mention only members."
				>
					<SettingsControlRow label="Lead bot">
						<LeadBotPicker
							value={project.leadBotId}
							privateProject={project.visibility === "private"}
							disabled={relead.isPending}
							onChange={(leadBotId) => void relead.mutateAsync({ leadBotId }).catch(() => {})}
						/>
					</SettingsControlRow>
				</SettingsGroup>
			)}
			<SettingsGroup>
				<SettingsRow
					label="Members"
					trailing={<SettingsValue>{project.memberCount}</SettingsValue>}
					chevron
					render={<Link {...projectMembersLink(project)} />}
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
							<span id={visibilitySubId}>
								{isPublic
									? "Listed for everyone in the workspace to join"
									: publicBlocked
										? privateBotsHoldReason(privateBotNames)
										: "Only members added to it can see it"}
							</span>
						}
						trailing={
							<Switch
								checked={isPublic}
								disabled={updateDetails.isPending || publicBlocked}
								aria-label={isPublic ? "Make private" : "Make public"}
								aria-describedby={visibilitySubId}
								onCheckedChange={(on) => {
									if (on) {
										setConfirmingPublic(true);
										return;
									}
									void updateDetails.mutateAsync({ visibility: "private" }).catch(() => {});
								}}
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
					description="Removes its chats and files."
					action="Delete"
					onClick={() => setConfirmingDelete(true)}
				/>
			)}
			<DeleteDialog
				open={confirmingDelete}
				onOpenChange={setConfirmingDelete}
				title={`Delete ${project.name}?`}
				description="Its chats and files will be deleted. This can't be undone."
				pending={remove.isPending}
				error={remove.error ? failureMessage(remove.error) : undefined}
				onDelete={deleteProject}
			/>
			<DeleteDialog
				open={confirmingPublic}
				onOpenChange={(open) => {
					setConfirmingPublic(open);
					if (!open) makePublic.reset();
				}}
				title={`Make ${project.name} public?`}
				description="Everyone in the workspace will be able to see it and join it, and read its chats and files."
				confirmLabel="Make public"
				pending={makePublic.isPending}
				error={makePublic.error ? failureMessage(makePublic.error) : undefined}
				onDelete={async () => {
					try {
						await makePublic.mutateAsync({ visibility: "public" });
					} catch {
						return;
					}
					setConfirmingPublic(false);
				}}
			/>
		</SettingsPage>
	);
}

/** Why a project with private bots can't be made public, and what to do first. */
function privateBotsHoldReason(names: readonly string[]) {
	const one = names.length === 1;
	return `Only members added to it can see it. It can't be public while ${listNames(names)} ${one ? "is a private bot" : "are private bots"} in it: take ${one ? "it" : "them"} out first, choosing another lead bot if needed.`;
}

/**
 * The bots added to the project, which answer there when mentioned, with
 * adding another bot that may be in it and taking one out for whoever may. The lead bot
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
			(bot) =>
				canBeInProject(bot, { private: project.visibility === "private" }) &&
				!inProject.has(bot.id),
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
								<DropdownMenuItem disabled>Every bot you can add is here.</DropdownMenuItem>
							) : (
								addable.map((bot) => (
									<BotMenuItem
										key={bot.id}
										bot={bot}
										onClick={() => place.mutate({ botId: bot.id, added: true })}
									/>
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
						icon={<BotAvatar color={bot.color} eyes={bot.eyes} shape={bot.shape} size={24} />}
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
 * The members in the project. Anyone in the workspace can be added.
 * Administrators are in every project, so who can be taken out, and whether
 * you may leave, is the API's answer.
 */
function Members({ project }: { project: Project }) {
	const members = useProjectMembers(project.id);
	const remove = usePlaceProjectMember(project.id);
	const leave = useLeaveProject(project.id);
	const navigate = useNavigate();
	const session = useSession();
	const isYou = (memberId: string) => memberId === session.member?.id;
	const pending = remove.isPending || leave.isPending;
	return (
		<MemberRows
			workspaceId={project.workspaceId}
			members={members}
			emptyLabel="Nobody is in this project yet"
			mayRemove={(member) =>
				isYou(member.memberId)
					? project.permissions.leave
					: project.permissions.manageMembers && member.removable
			}
			removeLabel={(member) =>
				isYou(member.memberId) ? `Leave ${project.name}` : `Remove ${member.name}`
			}
			confirmation={(member) =>
				isYou(member.memberId)
					? {
							title: `Leave ${project.name}?`,
							description: "You leave its chats. If it's public, you can join again.",
							confirmLabel: "Leave",
						}
					: {
							title: `Remove ${member.name} from ${project.name}?`,
							description: "They leave its chats. You can add them back at any time.",
							confirmLabel: "Remove",
						}
			}
			onRemove={async (member) => {
				if (!isYou(member.memberId)) {
					return remove.mutateAsync({ memberId: member.memberId, member: false });
				}
				await leave.mutateAsync();
				await navigate(projectsLink());
			}}
			pending={pending}
			error={remove.error ?? leave.error}
		/>
	);
}

/** Add members, beside the Members title. */
function AddMembersButton({ project }: { project: Project }) {
	const members = useProjectMembers(project.id);
	const invite = usePlaceProjectMember(project.id);
	return (
		<AddMembersMenu
			workspaceId={project.workspaceId}
			present={members.data}
			onAdd={(memberId) => invite.mutate({ memberId, member: true })}
			pending={invite.isPending}
			error={invite.error}
		/>
	);
}
