import { Emphasis } from "@/components/emphasis";
import { PodIcon } from "@/components/pod-icon";
import { MotionCard, Reveal, riseIn } from "@/components/reveal";
import { Section } from "@/components/section";
import { CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PodChat } from "@/landing/pod-chat";
import { pods } from "@/landing/pods";

export function PodsSection() {
	return (
		<Section
			eyebrow="Pods"
			tone="emerald"
			title="A group chat for the people you get stuff done with."
			description={
				<>
					A pod is a shared space for a group of <Emphasis>people</Emphasis> and their{" "}
					<Emphasis>agents</Emphasis>. Everyone in it sees the same chats, results and approvals.
				</>
			}
		>
			<Reveal className="grid grid-cols-2 gap-3 pt-3 md:grid-cols-4">
				{pods.map((pod) => (
					<MotionCard key={pod.name} variants={riseIn} className="gap-4 rounded-3xl">
						<CardHeader>
							<PodIcon size="lg" tint={pod.tint} bots={pod.bots} />
						</CardHeader>
						<CardContent className="flex flex-col gap-0.5">
							<CardTitle className="text-lg font-bold">{pod.name}</CardTitle>
							<CardDescription>{pod.description}</CardDescription>
						</CardContent>
					</MotionCard>
				))}
			</Reveal>
			<PodChat />
		</Section>
	);
}
