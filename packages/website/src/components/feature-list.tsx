import { cva, type VariantProps } from "class-variance-authority";
import { Reveal, RevealItem } from "@/components/reveal";

const featureGrid = cva("grid gap-8 pt-4", {
	variants: {
		columns: { 2: "md:grid-cols-2", 3: "md:grid-cols-3" },
	},
	defaultVariants: { columns: 3 },
});

export interface Feature {
	title: string;
	body: string;
}

interface FeatureListProps extends VariantProps<typeof featureGrid> {
	features: readonly Feature[];
}

/** Short titled points in a grid, revealed one after another. */
export function FeatureList({ features, columns }: FeatureListProps) {
	return (
		<Reveal>
			<dl className={featureGrid({ columns })}>
				{features.map(({ title, body }) => (
					<RevealItem key={title} className="flex flex-col gap-1.5">
						<dt className="text-lg font-bold">{title}</dt>
						<dd className="text-muted-foreground">{body}</dd>
					</RevealItem>
				))}
			</dl>
		</Reveal>
	);
}
