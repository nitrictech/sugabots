import { type ChatAuthor, ChatMessage, ChatText, ChatToolLine } from "@/components/chat";
import { Emphasis } from "@/components/emphasis";
import { MotionCard, Reveal, RevealItem, riseIn } from "@/components/reveal";
import { Section } from "@/components/section";
import { CardContent } from "@/components/ui/card";
import { bots } from "@/landing/bots";

/** An amount a bot quotes, set apart from the prose around it. */
function Amount({ children }: { children: string }) {
	return (
		<span className="font-mono text-sm font-medium text-yellow-700 dark:text-yellow-200">
			{children}
		</span>
	);
}

const authors = {
	tripPlanner: { kind: "bot", name: "Trip Planner", look: bots.tripPlanner },
	budgetKeeper: { kind: "bot", name: "Budget Keeper", look: bots.budgetKeeper },
} as const satisfies Record<string, ChatAuthor>;

export function CollaborationSection() {
	return (
		<Section
			layout="split"
			eyebrow="Collaboration"
			tone="sky"
			title="Ask one agent. It pulls in the right help."
			description={
				<>
					Each agent has its own prompt and model, and you choose which tools it can use. When it
					needs help, it <Emphasis tone="sky">asks another agent</Emphasis> in the pod, and you can
					read the whole exchange.
				</>
			}
		>
			<Reveal>
				<MotionCard variants={riseIn} className="rounded-3xl">
					{/* The two bots' exchange plays out once the card is in place. */}
					<Reveal stagger={0.6} delay={0.6}>
						<CardContent className="flex flex-col gap-4">
							<p className="text-sm font-semibold">Collaboration with Budget Keeper</p>
							<RevealItem>
								<ChatMessage author={authors.tripPlanner} time="7:13pm">
									<ChatText>Four seats at $176. Does that fit the Melbourne budget?</ChatText>
								</ChatMessage>
							</RevealItem>
							<RevealItem>
								<ChatMessage author={authors.budgetKeeper} time="7:13pm">
									<ChatToolLine>Used Sheets for 3s</ChatToolLine>
									<ChatText>
										Pot has <Amount>$924</Amount>. That leaves <Amount>$220</Amount> after flights.
									</ChatText>
									<ChatText>Fine by me. Hotel needs to stay under $150 a night.</ChatText>
								</ChatMessage>
							</RevealItem>
						</CardContent>
					</Reveal>
				</MotionCard>
			</Reveal>
		</Section>
	);
}
