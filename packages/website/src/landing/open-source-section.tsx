import { Emphasis } from "@/components/emphasis";
import { type Feature, FeatureList } from "@/components/feature-list";
import { Section } from "@/components/section";

const promises: readonly Feature[] = [
	{
		title: "Run it anywhere",
		body: "Your laptop, a home server or your own cloud, with Docker and Postgres.",
	},
	{
		title: "Privacy on your terms",
		body: "Messages go between you and the model provider you picked. With a local model, they go nowhere.",
	},
	{
		title: "Approve, ask, deny",
		body: "Connect agents to the tools you use, and they check with you before changing anything.",
	},
];

export function OpenSourceSection() {
	return (
		<Section
			eyebrow="Open source"
			tone="pink"
			title="Your bots, your data, your call."
			description={
				<>
					Sugabots is <Emphasis tone="pink">open source</Emphasis> and self-hosted. Your chats and
					keys stay in your own database.
				</>
			}
		>
			<FeatureList features={promises} />
		</Section>
	);
}
