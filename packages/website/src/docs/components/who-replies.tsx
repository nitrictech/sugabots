import { cn } from "cn";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { BotAvatar } from "@/components/bot-avatar";
import { ChatBubble, ChatMessage } from "@/components/chat";
import { riseIn } from "@/components/reveal";
import { Card } from "@/components/ui/card";
import { cast } from "@/docs/cast";

interface Scenario {
	label: string;
	message: string;
	/** The bot that answers, or none when the message is for people. */
	replier?: typeof cast.tripPlanner;
	why: string;
}

const scenarios: readonly Scenario[] = [
	{
		label: "Just write",
		message: "Can you find flights to Lisbon on Friday?",
		replier: cast.tripPlanner,
		why: "You're in Trip Planner's chat, so Trip Planner answers.",
	},
	{
		label: "Mention another bot",
		message: "Find flights, and check them with @budget-keeper",
		replier: cast.tripPlanner,
		why: "The chat's own bot still answers. It can bring Budget Keeper in itself, and you can read that exchange.",
	},
	{
		label: "Mention only people",
		message: "@sam are you free that weekend?",
		why: "A message that mentions only people is for them. No bot jumps in.",
	},
];

/** Pick a message to send in Trip Planner's chat and see who answers it. */
export function WhoReplies() {
	const [index, setIndex] = useState(0);
	const scenario = scenarios[index] ?? scenarios[0];
	if (!scenario) return null;

	return (
		<Card className="my-8 gap-0 rounded-3xl py-0 shadow-xl">
			<div className="flex flex-wrap items-center gap-2 border-b px-5 py-3">
				<span className="pr-1 text-sm font-semibold">In Trip Planner's chat:</span>
				{scenarios.map((option, optionIndex) => (
					<button
						key={option.label}
						type="button"
						aria-pressed={optionIndex === index}
						onClick={() => setIndex(optionIndex)}
						className={cn(
							"rounded-full border-2 px-3 py-0.5 text-sm font-semibold transition-colors",
							optionIndex === index
								? "border-foreground bg-foreground text-background"
								: "border-input text-muted-foreground hover:text-foreground",
						)}
					>
						{option.label}
					</button>
				))}
			</div>
			<AnimatePresence mode="wait" initial={false}>
				<motion.div
					key={index}
					initial="hidden"
					animate="visible"
					exit="hidden"
					variants={{ visible: { transition: { staggerChildren: 0.35 } } }}
					className="flex min-h-56 flex-col gap-3 px-4 py-5 sm:px-6"
				>
					<motion.div variants={riseIn}>
						<ChatMessage side="end">
							<ChatBubble tone="self" side="end">
								{scenario.message}
							</ChatBubble>
						</ChatMessage>
					</motion.div>
					<motion.div variants={riseIn}>
						{scenario.replier ? (
							<ChatMessage side="start" avatar={<BotAvatar {...scenario.replier.look} />}>
								<ChatBubble tone={scenario.replier.look.color} side="start">
									On it!
								</ChatBubble>
							</ChatMessage>
						) : (
							<p className="text-center text-sm font-semibold text-muted-foreground">
								The bots stay quiet
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
