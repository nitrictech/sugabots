import {
	CalendarClock20,
	FilePen20,
	FileText20,
	Globe20,
	type IconComponent,
	Library20,
	PencilLine20,
	Search20,
} from "@nitric/suga-icons";
import type { BuiltInToolKey } from "@sugabots/contracts";
import { builtInToolCatalog } from "@sugabots/contracts";
import { Reveal, RevealItem } from "@/components/reveal";

const toolIcons: Record<BuiltInToolKey, IconComponent> = {
	web_fetch: Globe20,
	web_search: Search20,
	routines: CalendarClock20,
	artifact_list: Library20,
	artifact_read: FileText20,
	artifact_write: FilePen20,
	artifact_edit: PencilLine20,
};

/** The tools every agent comes with, from the product's own catalog. */
export function BuiltInTools() {
	return (
		<Reveal className="my-8 grid gap-3 sm:grid-cols-2">
			{builtInToolCatalog.map(({ key, name, description }) => {
				const Icon = toolIcons[key];
				return (
					<RevealItem
						key={key}
						className="flex flex-col gap-2 rounded-3xl bg-card p-5 ring-1 ring-foreground/10"
					>
						<span className="flex size-10 items-center justify-center rounded-2xl bg-brand text-brand-foreground">
							<Icon />
						</span>
						<span className="text-lg font-bold">{name}</span>
						<span className="text-sm text-muted-foreground">{description}</span>
						<code className="w-fit text-xs">{key}</code>
					</RevealItem>
				);
			})}
		</Reveal>
	);
}
