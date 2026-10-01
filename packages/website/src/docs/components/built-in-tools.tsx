import type { BuiltInToolKey } from "@sugabots/contracts";
import { builtInToolCatalog } from "@sugabots/contracts";
import {
	FilePenIcon,
	FilePlusIcon,
	FileTextIcon,
	GlobeIcon,
	LibraryIcon,
	type LucideIcon,
	PencilLineIcon,
	SearchIcon,
} from "lucide-react";
import { Reveal, RevealItem } from "@/components/reveal";

const toolIcons: Record<BuiltInToolKey, LucideIcon> = {
	web_fetch: GlobeIcon,
	web_search: SearchIcon,
	artifact_list: LibraryIcon,
	artifact_read: FileTextIcon,
	artifact_create: FilePlusIcon,
	artifact_replace: FilePenIcon,
	document_replace_section: PencilLineIcon,
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
							<Icon className="size-5" />
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
