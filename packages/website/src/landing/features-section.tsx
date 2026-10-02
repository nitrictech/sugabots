import { Emphasis } from "@/components/emphasis";
import { type Feature, FeatureList } from "@/components/feature-list";
import { Section } from "@/components/section";

const features: readonly Feature[] = [
	{
		title: "Routines",
		body: "Put an agent on a schedule or trigger it from a webhook. Every run is kept, and the same approvals apply.",
	},
	{
		title: "Connect your tools",
		body: "Plug any MCP server into a pod, from Linear to Notion. Have agents ask before each tool call, or let them run freely.",
	},
	{
		title: "Usage you can see",
		body: "See the tokens and cost behind every conversation.",
	},
	{
		title: "Roles and private pods",
		body: "Admins, members and viewers. Personal pods stay private, even from admins.",
	},
];

export function FeaturesSection() {
	return (
		<Section
			eyebrow="Beyond the chat"
			tone="purple"
			title="Agents that keep working."
			description={
				<>
					Give agents <Emphasis tone="purple">schedules</Emphasis> and{" "}
					<Emphasis tone="purple">tools</Emphasis>, and keep an eye on what they do.
				</>
			}
		>
			<FeatureList features={features} columns={2} />
		</Section>
	);
}
