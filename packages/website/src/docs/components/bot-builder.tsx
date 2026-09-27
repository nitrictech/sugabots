import { type BotColor, botColors } from "@sugabots/avatars";
import { type AgentFace, agentColors, agentFaces } from "@sugabots/contracts";
import { cn } from "cn";
import { AnimatePresence, motion } from "motion/react";
import { useId, useState } from "react";
import { BotAvatar } from "@/components/bot-avatar";
import { ChatBubble, ChatMessage } from "@/components/chat";
import { popIn } from "@/components/reveal";
import { Card, CardContent } from "@/components/ui/card";

const NAME_MAX_LENGTH = 24;

function greeting(name: string) {
	const shownName = name.trim() || "your new bot";
	return `Hi! I'm ${shownName}. Give me a job and a model, and invite me into a pod.`;
}

/** A playground for a bot's look: pick a name, a colour and a face, and see it say hello. */
export function BotBuilder() {
	const [name, setName] = useState("Recipe Scout");
	const [color, setColor] = useState<BotColor>("orange");
	const [face, setFace] = useState<AgentFace>("dot");
	const nameId = useId();

	return (
		<Card className="my-8 gap-0 rounded-3xl py-0 shadow-xl sm:flex-row">
			<CardContent className="flex flex-col gap-5 border-b py-5 sm:w-64 sm:border-r sm:border-b-0">
				<label htmlFor={nameId} className="flex flex-col gap-1.5 text-sm font-semibold">
					Name
					<input
						id={nameId}
						value={name}
						maxLength={NAME_MAX_LENGTH}
						onChange={(event) => setName(event.target.value)}
						className="h-9 rounded-xl border-2 border-input bg-background px-3 font-normal outline-none focus-visible:border-ring"
					/>
				</label>
				<fieldset className="flex flex-col gap-2">
					<legend className="pb-1.5 text-sm font-semibold">Colour</legend>
					<div className="flex flex-wrap gap-2">
						{agentColors.map((option) => (
							<button
								key={option}
								type="button"
								aria-label={option}
								aria-pressed={option === color}
								onClick={() => setColor(option)}
								style={{ background: botColors[option].face }}
								className={cn(
									"size-7 rounded-full ring-offset-2 ring-offset-card transition-transform hover:scale-110",
									option === color && "ring-2 ring-foreground",
								)}
							/>
						))}
					</div>
				</fieldset>
				<fieldset className="flex flex-col gap-2">
					<legend className="pb-1.5 text-sm font-semibold">Eyes</legend>
					<div className="flex flex-wrap gap-2">
						{agentFaces.map((option) => (
							<button
								key={option}
								type="button"
								aria-label={option}
								aria-pressed={option === face}
								onClick={() => setFace(option)}
								className={cn(
									"rounded-full ring-offset-2 ring-offset-card transition-transform hover:scale-110",
									option === face && "ring-2 ring-foreground",
								)}
							>
								<BotAvatar size="sm" color={color} face={option} />
							</button>
						))}
					</div>
				</fieldset>
			</CardContent>
			<div className="flex min-h-64 flex-1 flex-col items-center justify-center gap-6 bg-background/50 p-6">
				<AnimatePresence mode="popLayout" initial={false}>
					<motion.div
						key={`${color}-${face}`}
						variants={popIn}
						initial="hidden"
						animate="visible"
						exit="hidden"
					>
						<BotAvatar color={color} face={face} className="size-24 -rotate-6" />
					</motion.div>
				</AnimatePresence>
				<div className="w-full max-w-sm">
					<ChatMessage side="start" avatar={<BotAvatar size="sm" color={color} face={face} />}>
						<span className="px-1 text-xs font-semibold text-muted-foreground">
							{name.trim() || "New bot"}
						</span>
						<ChatBubble tone={color} side="start" size="sm">
							{greeting(name)}
						</ChatBubble>
					</ChatMessage>
				</div>
			</div>
		</Card>
	);
}
