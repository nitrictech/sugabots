import { projectLinks } from "@sugabots/contracts/project-links";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Plus } from "lucide-react";
import { useSignOut } from "@/lib/session.ts";
import { chooseWorkspace, useWorkspace, useWorkspaces } from "@/lib/workspace.ts";
import { SettingsListGroups } from "@/screens/SettingsLayout.tsx";
import { PageHeader } from "@/shell/Page.tsx";
import { LetterTile } from "@/ui/letter-tile.tsx";
import { SettingsGroup, SettingsRow } from "@/ui/settings-page.tsx";

/**
 * Settings, as a phone's last tab, You: you first, on a card that opens your
 * own settings, then the list of settings, then any other workspace you belong to, help, and signing out.
 * Each opens its page of the settings over this one, whose Back returns here.
 */
export function You() {
	const signOut = useSignOut();
	const { workspace } = useWorkspace();
	const { data: workspaces } = useWorkspaces();
	if (!workspace) return null;
	const others = (workspaces ?? []).filter((one) => one.id !== workspace.id);

	return (
		<section aria-label="Settings" className="flex min-h-0 min-w-0 flex-1 flex-col">
			<PageHeader title="Settings" place={{ kind: "tab" }} />
			<div
				data-scroll-restoration-id="settings-tab"
				className="tab-bar-clearance flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pt-1.5 pb-6 md:mx-auto md:w-full md:max-w-xl md:pt-6"
			>
				<SettingsListGroups />
				<SettingsGroup label={others.length > 0 ? "Other workspaces" : undefined} headingLevel={2}>
					{others.map((other) => (
						<SettingsRow
							key={other.id}
							icon={
								<LetterTile
									name={other.name}
									className="size-6 rounded-md border-0 bg-foreground text-background"
								/>
							}
							label={other.name}
							chevron
							render={
								<Link
									to="/$workspace"
									params={{ workspace: other.slug }}
									onClick={() => chooseWorkspace(other.id)}
								/>
							}
						/>
					))}
					<SettingsRow
						icon={
							<span
								aria-hidden
								className="grid size-6 shrink-0 place-items-center rounded-md border border-border-dashed border-dashed text-muted-foreground"
							>
								<Plus size={14} strokeWidth={2.25} />
							</span>
						}
						label="New workspace"
						chevron
						render={<Link to="/workspace-setup" />}
					/>
				</SettingsGroup>
				<SettingsGroup>
					<SettingsRow
						label="Help and docs"
						trailing={
							<ArrowUpRight
								aria-hidden
								size={16}
								strokeWidth={2}
								className="text-subtle-foreground"
							/>
						}
						render={
							<a href={projectLinks.documentation} target="_blank" rel="noopener noreferrer" />
						}
					/>
					<SettingsRow
						label={<span className="text-destructive-text">Sign out</span>}
						onClick={() => void signOut()}
					/>
				</SettingsGroup>
			</div>
		</section>
	);
}
