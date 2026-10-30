import type { Pod } from "@sugabots/contracts";
import { projectLinks } from "@sugabots/contracts/project-links";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Plus } from "lucide-react";
import { podSettingsPageLink } from "@/lib/links.ts";
import { useSandboxAccess } from "@/lib/sandbox-providers.ts";
import { useSignOut } from "@/lib/session.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { chooseWorkspace, useWorkspace, useWorkspaces } from "@/lib/workspace.ts";
import { podSettingsPagesOf } from "@/lib/workspace-settings.ts";
import { SettingsListGroups, usePodCounts } from "@/screens/SettingsLayout.tsx";
import { PageHeader } from "@/shell/Page.tsx";
import { PodInitial } from "@/shell/SidebarPod.tsx";
import { BACK_BUTTON, BackChevron } from "@/ui/back-button.tsx";
import { SettingsGroup, SettingsRow, SettingsValue } from "@/ui/settings-page.tsx";

/**
 * You, as a phone's last tab: the list of settings, where each pod opens a
 * page of its own pages, then any other workspace you belong to, help, and
 * signing out. Each leads to its page, whose Back returns here.
 */
export function You() {
	const signOut = useSignOut();
	const { workspace } = useWorkspace();
	const { data: workspaces } = useWorkspaces();
	const settingsBack = useBackToHere("You");
	if (!workspace) return null;
	const others = (workspaces ?? []).filter((one) => one.id !== workspace.id);

	return (
		<section aria-label="You" className="flex min-h-0 min-w-0 flex-1 flex-col">
			<PageHeader title="You" place={{ kind: "tab" }} />
			<div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pt-1.5 pb-6 md:mx-auto md:w-full md:max-w-xl md:pt-6">
				<SettingsListGroups
					linkState={settingsBack}
					podLink={(pod) => (
						<Link from="/$workspace" to="./you/pods/$pod" params={{ pod: pod.slug }} />
					)}
				/>
				<SettingsGroup label={others.length > 0 ? "Other workspaces" : undefined} headingLevel={2}>
					{others.map((other) => (
						<SettingsRow
							key={other.id}
							icon={<LetterTile letter={other.name} />}
							label={other.name}
							chevron
							render={
								<Link
									to="/$workspace/agents"
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
						render={<Link to="/onboarding" />}
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

/**
 * A pod's settings as a phone opens them from You: its pages, each with how
 * much it holds, and each a page of its own whose Back returns here.
 */
export function YouPod({ pod }: { pod: Pod }) {
	const computers = useSandboxAccess().data?.enabled === true;
	const counts = usePodCounts(pod, true);
	const settingsBack = useBackToHere(pod.name);
	return (
		<section aria-label={pod.name} className="flex min-h-0 min-w-0 flex-1 flex-col">
			<header className="flex shrink-0 items-center gap-3 px-4 pt-[max(12px,env(safe-area-inset-top))] pb-2">
				<Link from="/$workspace" to="./you" aria-label="Back to You" className={BACK_BUTTON}>
					<BackChevron />
				</Link>
			</header>
			<div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pt-1.5 pb-6 md:mx-auto md:w-full md:max-w-xl">
				<div className="flex items-center gap-3 px-1">
					<PodInitial pod={pod} />
					<h1 className="m-0 min-w-0 truncate font-semibold text-[28px] text-foreground tracking-[-0.02em]">
						{pod.name}
					</h1>
				</div>
				<SettingsGroup>
					{podSettingsPagesOf(pod, computers).map((page) => (
						<SettingsRow
							key={page.id}
							label={page.label}
							trailing={
								counts[page.id] !== undefined && <SettingsValue>{counts[page.id]}</SettingsValue>
							}
							chevron
							render={<Link {...podSettingsPageLink(pod, page.id)} state={settingsBack} />}
						/>
					))}
				</SettingsGroup>
			</div>
		</section>
	);
}

/** A workspace's mark: the first letter of its name on a light square. */
function LetterTile({ letter }: { letter: string }) {
	return (
		<span
			aria-hidden
			className="grid size-6 shrink-0 place-items-center rounded-md bg-foreground font-semibold text-[12px] text-background"
		>
			{Array.from(letter.trim())[0]?.toUpperCase() ?? "?"}
		</span>
	);
}
