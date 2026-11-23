import { type BuiltInProvider, builtInProviders } from "@sugabots/contracts";
import { ProviderLogo } from "@sugabots/provider-logos";
import { useState } from "react";
import { Reveal, RevealItem } from "@/components/reveal";
import { ChoiceChips } from "@/components/ui/choice-chips";

const filterLabels = {
	all: "All",
	remote: "Hosted services",
	local: "On your own machine",
} as const;

type Filter = keyof typeof filterLabels;

const filterMatches: Record<Filter, (builtIn: BuiltInProvider) => boolean> = {
	all: () => true,
	remote: (builtIn) => builtIn.hosting === "remote",
	local: (builtIn) => builtIn.hosting === "local",
};

/** Every built-in model provider, straight from the list Sugabots ships, filterable by where it runs. */
export function ProviderGrid() {
	const [filter, setFilter] = useState<Filter>("all");
	const shown = builtInProviders.filter(filterMatches[filter]);

	return (
		<div className="my-8 flex flex-col gap-4">
			<ChoiceChips
				label="Where it runs"
				labelClassName="sr-only"
				options={filterLabels}
				value={filter}
				onChange={setFilter}
			/>
			<Reveal
				key={filter}
				stagger={0.03}
				// Taller than a phone screen, so it starts as soon as any of it shows.
				viewport={{ once: true, amount: "some" }}
				className="grid gap-2 sm:grid-cols-2"
			>
				{shown.map((builtIn) => (
					<RevealItem
						key={builtIn.id}
						className="flex items-start gap-3 rounded-2xl bg-card p-3.5 ring-1 ring-foreground/10"
					>
						<span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-background ring-1 ring-foreground/10">
							<ProviderLogo builtIn={builtIn.id} className="size-5" />
						</span>
						<span className="flex min-w-0 flex-col">
							<span className="font-semibold">{builtIn.name}</span>
							<span className="text-sm text-muted-foreground text-pretty">{builtIn.hint}</span>
						</span>
					</RevealItem>
				))}
			</Reveal>
		</div>
	);
}
