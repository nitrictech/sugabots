import { useProjectBots } from "@/lib/projects.ts";
import { ownerName, type ResourceOwner } from "@/lib/resource-owner.tsx";
import { OwnerCrumb } from "@/shell/BotCrumb.tsx";
import { Page } from "@/shell/Page.tsx";
import { SettingsPage } from "@/ui/settings-page.tsx";
import { ProjectComputerSettings } from "./ProjectComputerSettings.tsx";

/**
 * The owner's computer, as one of its own pages beside its threads: how it
 * stands, its disk, and the hosts it may reach. A bot's is its default
 * project's.
 */
export function ComputerSettingsPage({ owner }: { owner: ResourceOwner }) {
	const name = ownerName(owner);
	// The bots whose homes the disk's folders may be: a bot alone, or a project's bots.
	const projectBots = useProjectBots("project" in owner ? owner.project.id : undefined).data;
	const bots = "bot" in owner ? [owner.bot] : (projectBots ?? []);
	return (
		<Page title="Computers" parent={<OwnerCrumb owner={owner} />} place={{ kind: "owner", owner }}>
			<SettingsPage
				description={
					"bot" in owner
						? `The computer ${name} runs commands, browses and edits files on. Experimental.`
						: `The computer the bots in ${name} run commands, browse and edit files on there. Experimental.`
				}
			>
				<ProjectComputerSettings owner={owner} bots={bots} />
			</SettingsPage>
		</Page>
	);
}
