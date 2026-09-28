import { type ProviderPreset, providerCatalog } from "@sugabots/contracts";
import { ProviderLogo } from "@sugabots/provider-logos";
import { cn } from "cn";
import { useState } from "react";
import { Reveal, RevealItem } from "@/components/reveal";

const filters = {
	all: { label: "All", matches: () => true },
	remote: {
		label: "Hosted services",
		matches: (preset: ProviderPreset) => preset.hosting === "remote",
	},
	local: {
		label: "On your own machine",
		matches: (preset: ProviderPreset) => preset.hosting === "local",
	},
} as const;

type Filter = keyof typeof filters;

/** Every model provider Sugabots has a preset for, straight from its catalog, filterable by where it runs. */
export function ProviderGrid() {
	const [filter, setFilter] = useState<Filter>("all");
	const shown = providerCatalog.filter(filters[filter].matches);

	return (
		<div className="my-8 flex flex-col gap-4">
			<fieldset className="flex flex-wrap gap-2">
				<legend className="sr-only">Where it runs</legend>
				{(Object.keys(filters) as Filter[]).map((key) => (
					<button
						key={key}
						type="button"
						aria-pressed={key === filter}
						onClick={() => setFilter(key)}
						className={cn(
							"rounded-full border-2 px-3.5 py-1 text-sm font-semibold transition-colors",
							key === filter
								? "border-foreground bg-foreground text-background"
								: "border-input text-muted-foreground hover:border-muted-foreground hover:text-foreground",
						)}
					>
						{filters[key].label}
					</button>
				))}
			</fieldset>
			<Reveal
				key={filter}
				stagger={0.03}
				// Taller than a phone screen, so it starts as soon as any of it shows.
				viewport={{ once: true, amount: "some" }}
				className="grid gap-2 sm:grid-cols-2"
			>
				{shown.map((preset) => (
					<RevealItem
						key={preset.id}
						className="flex items-start gap-3 rounded-2xl bg-card p-3.5 ring-1 ring-foreground/10"
					>
						<span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-background ring-1 ring-foreground/10">
							<ProviderLogo preset={preset.id} className="size-5" />
						</span>
						<span className="flex min-w-0 flex-col">
							<span className="font-semibold">{preset.name}</span>
							<span className="text-sm text-muted-foreground text-pretty">{preset.hint}</span>
						</span>
					</RevealItem>
				))}
			</Reveal>
		</div>
	);
}
