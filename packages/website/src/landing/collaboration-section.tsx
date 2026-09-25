import { BotAvatar } from "@/components/bot-avatar";
import { ChatBubble, ChatMessage, ChatNote } from "@/components/chat";
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
						<CardContent className="flex flex-col gap-3">
							<ChatNote>Trip Planner with Budget Keeper</ChatNote>
							<RevealItem>
								<ChatMessage side="end" avatar={<BotAvatar size="sm" {...bots.tripPlanner} />}>
									<ChatBubble tone={bots.tripPlanner.color} side="end" size="sm">
										Four seats at €176. Does that fit the Lisbon budget?
									</ChatBubble>
								</ChatMessage>
							</RevealItem>
							<RevealItem className="pl-9 text-xs font-medium text-muted-foreground">
								Used Sheets for 3s
							</RevealItem>
							<RevealItem>
								<ChatMessage side="start" avatar={<BotAvatar size="sm" {...bots.budgetKeeper} />}>
									<ChatBubble tone={bots.budgetKeeper.color} side="start" size="sm">
										Pot has <Amount>€924</Amount>. That leaves <Amount>€220</Amount> after flights.
									</ChatBubble>
									<ChatBubble tone={bots.budgetKeeper.color} side="start" size="sm">
										Fine by me. Hotel needs to stay under €150 a night.
									</ChatBubble>
								</ChatMessage>
							</RevealItem>
						</CardContent>
					</Reveal>
				</MotionCard>
			</Reveal>
		</Section>
	);
}
