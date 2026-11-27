import {
	leastUsedProjectColor,
	PROJECT_DESCRIPTION_MAX_LENGTH,
	PROJECT_NAME_MAX_LENGTH,
	type Project,
	type ProjectColor,
	type ProjectVisibility,
	slugify,
} from "@sugabots/contracts";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import { useBots } from "@/lib/bots.ts";
import { failureMessage } from "@/lib/failure.ts";
import { projectLink } from "@/lib/links.ts";
import { useCreateProject, useProjects } from "@/lib/projects.ts";
import { useWorkspacePermissions } from "@/lib/workspace.ts";
import { ProjectColourPicker } from "@/shell/AvatarPicker.tsx";
import { canBeInProject, LeadBotPicker } from "@/shell/LeadBotPicker.tsx";
import { ProjectInitial } from "@/shell/SidebarProject.tsx";
import { Alert } from "@/ui/alert.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import {
	DialogForm,
	DialogFormBody,
	DialogFormFooter,
	DialogFormHeader,
} from "@/ui/dialog-form.tsx";
import { RadioGroup, RadioGroupItem } from "@/ui/radio-group.tsx";
import { SettingsControlRow, SettingsFieldRow, SettingsGroup } from "@/ui/settings-page.tsx";

/**
 * Making a project: a name, what it's for, its lead bot, whether anyone may
 * join it, and a colour, under the project as the sidebar will show it. Its
 * members and other bots come after.
 */
export function NewProjectDialog({
	onCreated,
}: {
	onCreated: (project: Project) => Promise<void>;
}) {
	const [name, setName] = useState("");
	const { data: projects } = useProjects();
	const [chosenColor, setChosenColor] = useState<ProjectColor>();
	const [description, setDescription] = useState("");
	const [visibility, setVisibility] = useState<ProjectVisibility>("public");
	const [leadBotId, setLeadBotId] = useState<string | null>(null);
	const { bots } = useBots();
	// Until somebody picks one, the colour the workspace's projects have least of,
	// so projects made without a second thought still look unlike each other.
	const color =
		chosenColor ?? leastUsedProjectColor(projects?.map((project) => project.color) ?? []);
	const create = useCreateProject();
	// The API makes the project's address from its name, so a name with nothing to make one from is no name.
	const usable = slugify(name) !== "";

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!usable || !leadBotId) return;
		try {
			const project = await create.mutateAsync({
				name,
				color,
				visibility,
				description: description.trim() || null,
				leadBotId,
			});
			await onCreated(project);
		} catch {
			return;
		}
	}

	return (
		<DialogForm onSubmit={submit}>
			<DialogFormHeader title="New project" />

			<DialogFormBody gap="compact">
				<div className="flex justify-center pt-1 pb-2">
					{/* The project as the sidebar will show it: its initial, once named, on its colour. */}
					<ProjectInitial
						project={{ name, color }}
						size="lg"
						className="size-16 rounded-2xl text-2xl"
					/>
				</div>
				<SettingsGroup note="The lead bot answers the project's chats unless members mention another. You can add members and bots next.">
					<SettingsFieldRow
						label="Name"
						value={name}
						onChange={setName}
						placeholder="e.g. Support"
						maxLength={PROJECT_NAME_MAX_LENGTH}
					/>
					<SettingsFieldRow
						label="Description"
						value={description}
						onChange={setDescription}
						placeholder="What it's for"
						maxLength={PROJECT_DESCRIPTION_MAX_LENGTH}
					/>
					<SettingsControlRow label="Lead bot">
						<LeadBotPicker
							value={leadBotId}
							onChange={setLeadBotId}
							privateProject={visibility === "private"}
						/>
					</SettingsControlRow>
					<SettingsControlRow label="Who can join">
						<RadioGroup
							aria-label="Who can join"
							value={visibility}
							onValueChange={(chosen) => {
								setVisibility(chosen);
								// A private bot leads only a private project.
								const lead = bots?.find((bot) => bot.id === leadBotId);
								if (lead && !canBeInProject(lead, { private: chosen === "private" })) {
									setLeadBotId(null);
								}
							}}
						>
							{[
								{ value: "public", label: "Anyone" },
								{ value: "private", label: "Invited only" },
							].map((option) => (
								<RadioGroupItem key={option.value} value={option.value}>
									{option.label}
								</RadioGroupItem>
							))}
						</RadioGroup>
					</SettingsControlRow>
					<SettingsControlRow label="Colour">
						<ProjectColourPicker value={color} onChange={setChosenColor} />
					</SettingsControlRow>
				</SettingsGroup>

				{create.error && (
					<Alert>
						{failureMessage(create.error, {
							Conflict: "A project with that name already exists. Try another name.",
							Forbidden: "You can't make a project in this workspace.",
						})}
					</Alert>
				)}
			</DialogFormBody>
			<DialogFormFooter
				action="Create"
				actionDisabled={!usable || !leadBotId || create.isPending}
			/>
		</DialogForm>
	);
}

/**
 * What starts a project, absent where the viewer may not make one, and the
 * dialog that makes it, which must be rendered for it to open. It opens the
 * project once it is made.
 */
export function useNewProject(): { start?: () => void; dialog: ReactNode } {
	const [creating, setCreating] = useState(false);
	const navigate = useNavigate();
	const may = useWorkspacePermissions();
	return {
		start: may.createProjects ? () => setCreating(true) : undefined,
		dialog: (
			<Dialog open={creating} onOpenChange={setCreating}>
				<NewProjectDialog
					onCreated={async (project) => {
						setCreating(false);
						await navigate(projectLink(project));
					}}
				/>
			</Dialog>
		),
	};
}
