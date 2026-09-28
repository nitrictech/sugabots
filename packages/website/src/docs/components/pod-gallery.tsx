import { PodIcon } from "@/components/pod-icon";
import { MotionCard, Reveal, riseIn } from "@/components/reveal";
import { CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { pods } from "@/landing/pods";

/** The landing page's example pods, as a reminder of the kinds of groups pods are for. */
export function PodGallery() {
	return (
		<Reveal className="my-8 grid grid-cols-2 gap-3 md:grid-cols-4">
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
	);
}
