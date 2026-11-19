import { useProjectBots } from "@/lib/projects.ts";
import { ownerLink, ownerName, type ResourceOwner } from "@/lib/resource-owner.tsx";
import { useBackTarget } from "@/lib/settings-back.tsx";
import { PageBackLink, SettingsPage } from "@/ui/settings-page.tsx";
import { ProjectComputerSettings } from "./ProjectComputerSettings.tsx";

/*
 * The settings page a bot and a project each have for what they hold: their
 * computer. A bot's is its default project's.
 */

/** The owner's computer: how it stands, its disk, and the hosts it may reach. */
export function ComputerSettingsPage({ owner }: { owner: ResourceOwner }) {
	const name = ownerName(owner);
	const back = useBackTarget({ label: name, render: ownerLink(owner, { page: "settings" }) });
	// The bots whose homes the disk's folders may be: a bot alone, or a project's bots.
	const projectBots = useProjectBots("project" in owner ? owner.project.id : undefined).data;
	const bots = "bot" in owner ? [owner.bot] : (projectBots ?? []);
	return (
		<SettingsPage
			back={<PageBackLink {...back} />}
			title="Computer"
			description={
				"bot" in owner
					? `The computer ${name} runs commands, browses and edits files on. Experimental.`
					: `The computer the bots in ${name} run commands, browse and edit files on there. Experimental.`
			}
		>
			<ProjectComputerSettings owner={owner} bots={bots} />
		</SettingsPage>
	);
}
