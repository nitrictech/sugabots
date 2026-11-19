import type { Project } from "@sugabots/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { projectLink } from "@/lib/links.ts";
import { useJoinProject, useProjects } from "@/lib/projects.ts";
import { useWorkspacePermissions } from "@/lib/workspace.ts";
import { NewProjectDialog } from "@/shell/NewProject.tsx";
import { Page } from "@/shell/Page.tsx";
import { PrivateMark, ProjectInitial } from "@/shell/SidebarProject.tsx";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { SettingsGroup, SettingsRow } from "@/ui/settings-page.tsx";

/**
 * Every project the person could be in: those they are in, then the public
 * ones they could join, each by name and what it's for, with Join or Open.
 * A + makes another.
 */
export function ProjectsDirectory() {
	const { data: projects, isPending, error } = useProjects();
	const may = useWorkspacePermissions();
	const join = useJoinProject();
	const navigate = useNavigate();
	const [creating, setCreating] = useState(false);
	const yours = projects?.filter((project) => project.isMember) ?? [];
	const others = projects?.filter((project) => !project.isMember) ?? [];
	return (
		<Page
			title="Projects"
			place={{ kind: "tab" }}
			actions={
				may.createProjects && (
					<IconButton label="New project" variant="bar" onClick={() => setCreating(true)}>
						<Plus size={16} strokeWidth={1.75} />
					</IconButton>
				)
			}
		>
			<div className="mx-auto flex w-full max-w-180 flex-col gap-6 px-4 pt-6 pb-12">
				{error && <Alert>{failureMessage(error)}</Alert>}
				{join.error && <Alert>{failureMessage(join.error)}</Alert>}
				{!isPending && projects?.length === 0 && (
					<EmptyState title="No projects yet">
						{may.createProjects
							? "Make the first one with the + above."
							: "Ask someone in the workspace to make one."}
					</EmptyState>
				)}
				{yours.length > 0 && (
					<SettingsGroup label="Yours" headingLevel={2}>
						{yours.map((project) => (
							<ProjectRow key={project.id} project={project} />
						))}
					</SettingsGroup>
				)}
				{others.length > 0 && (
					<SettingsGroup label="To join" headingLevel={2}>
						{others.map((project) => (
							<ProjectRow
								key={project.id}
								project={project}
								onJoin={
									project.permissions.join
										? () =>
												// Why it failed shows above the list.
												join.mutate(project.id, {
													onSuccess: () => void navigate(projectLink(project)),
												})
										: undefined
								}
								joining={join.isPending && join.variables === project.id}
							/>
						))}
					</SettingsGroup>
				)}
			</div>
			<Dialog open={creating} onOpenChange={setCreating}>
				<NewProjectDialog
					onCreated={async (project) => {
						setCreating(false);
						await navigate(projectLink(project));
					}}
				/>
			</Dialog>
		</Page>
	);
}

/** A project in the directory: its mark, name and what it's for, opening it once you're in. */
function ProjectRow({
	project,
	onJoin,
	joining = false,
}: {
	project: Project;
	/** Joins it, for a project the viewer is not in and may join. */
	onJoin?: () => void;
	joining?: boolean;
}) {
	const label = (
		<span className="flex min-w-0 items-center gap-1.5">
			<span className="truncate">{project.name}</span>
			{project.visibility === "private" && <PrivateMark />}
		</span>
	);
	if (project.isMember) {
		return (
			<SettingsRow
				icon={<ProjectInitial project={project} />}
				label={label}
				sub={project.description ?? undefined}
				chevron
				render={<Link {...projectLink(project)} />}
			/>
		);
	}
	return (
		<SettingsRow
			icon={<ProjectInitial project={project} />}
			label={label}
			sub={project.description ?? undefined}
			trailing={
				onJoin && (
					<Button
						size="sm"
						variant="secondary"
						aria-label={`Join ${project.name}`}
						disabled={joining}
						onClick={onJoin}
					>
						Join
					</Button>
				)
			}
		/>
	);
}
