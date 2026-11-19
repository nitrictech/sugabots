import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { cast } from "@/cast";
import { type ChatBot, ChatMessage, ChatText } from "@/components/chat";
import { riseIn } from "@/components/reveal";
import { Card } from "@/components/ui/card";
import { ChoiceChips } from "@/components/ui/choice-chips";

interface Scenario {
	label: string;
	message: string;
	/** The bot that answers, or none when it reads the message and leaves it to the people. */
	replier?: ChatBot;
	why: string;
}

const scenarios = {
	justWrite: {
		label: "Just write",
		message: "Can you find flights to Lisbon on Friday?",
		replier: cast.tripPlanner,
		why: "You're in a thread with Trip Planner, so Trip Planner answers.",
	},
	mentionAnotherBot: {
		label: "Mention another bot",
		message: "Find flights, and check them with @budget-keeper",
		replier: cast.tripPlanner,
		why: "The thread's own bot still answers. It can bring Budget Keeper in itself, and you can read that exchange.",
	},
	mentionOnlyPeople: {
		label: "Mention only people",
		message: "@sam are you free that weekend?",
		why: "A message that mentions only people is likely for them. Trip Planner reads it, and answers only if it can help; otherwise it leaves a 👀 to show it read it.",
	},
} satisfies Record<string, Scenario>;

type ScenarioName = keyof typeof scenarios;

const scenarioLabels = Object.fromEntries(
	Object.entries(scenarios).map(([name, scenario]) => [name, scenario.label]),
) as Record<ScenarioName, string>;

/** Pick a message to send in a thread with Trip Planner and see who answers it. */
export function WhoReplies() {
	const [picked, setPicked] = useState<ScenarioName>("justWrite");
	const scenario: Scenario = scenarios[picked];

	return (
		<Card className="my-8 gap-0 rounded-3xl py-0 shadow-xl">
			<ChoiceChips
				label="In a thread with Trip Planner:"
				labelClassName="float-left pr-1 text-sm font-semibold"
				className="border-b px-5 py-3"
				options={scenarioLabels}
				value={picked}
				onChange={setPicked}
			/>
			<AnimatePresence mode="wait" initial={false}>
				<motion.div
					key={picked}
					initial="hidden"
					animate="visible"
					exit="hidden"
					variants={{ visible: { transition: { staggerChildren: 0.35 } } }}
					className="flex min-h-56 flex-col gap-4 px-4 py-5 sm:px-6"
				>
					<motion.div variants={riseIn}>
						<ChatMessage author={cast.you}>
							<ChatText>{scenario.message}</ChatText>
						</ChatMessage>
					</motion.div>
					<motion.div variants={riseIn}>
						{scenario.replier ? (
							<ChatMessage author={scenario.replier}>
								<ChatText>On it!</ChatText>
							</ChatMessage>
						) : (
							<p className="text-center text-sm font-semibold text-muted-foreground">
								Trip Planner reacts 👀 and stays quiet
							</p>
						)}
					</motion.div>
					<motion.p
						variants={riseIn}
						className="mt-auto rounded-2xl bg-muted px-4 py-3 text-sm text-pretty"
					>
						{scenario.why}
					</motion.p>
				</motion.div>
			</AnimatePresence>
		</Card>
	);
}
