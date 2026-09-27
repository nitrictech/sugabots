import { cn } from "cn";
import { MessagesSquareIcon, PlugIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useState } from "react";
import { BotAvatar } from "@/components/bot-avatar";
import { PodIcon } from "@/components/pod-icon";
import { riseIn } from "@/components/reveal";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Card } from "@/components/ui/card";
import { cast } from "@/docs/cast";

const parts = {
	people: {
		label: "People",
		explanation:
			"Everyone added to the pod sees the same chats, results and approvals. Admins can reach every shared pod.",
	},
	bots: {
		label: "Bots",
		explanation:
			"Each bot lives in one pod, with its own instructions and model. Bots in a pod can ask each other for help.",
	},
	chats: {
		label: "Chats",
		explanation:
			"Every bot has one chat in its pod, shared by everyone in it. Talk to a bot there, together.",
	},
	connections: {
		label: "Connections",
		explanation:
			"Tools from apps like Linear or Notion, plugged in once for the whole pod. Every bot in it can use them, with your approval.",
	},
} as const;

type Part = keyof typeof parts;

/** One region of the map, dimmed while another is picked. */
function Region({ part, picked, children }: { part: Part; picked: Part; children: ReactNode }) {
	const isPicked = part === picked;
	return (
		<div
			className={cn(
				"flex flex-col gap-3 rounded-2xl p-4 transition-all duration-300",
				isPicked ? "bg-background shadow-lg ring-2 ring-brand" : "opacity-40",
			)}
		>
			<p className="text-xs font-bold tracking-wide text-muted-foreground uppercase">
				{parts[part].label}
			</p>
			{children}
		</div>
	);
}

function PersonFace({ initials }: { initials: string }) {
	return (
		<Avatar size="lg">
			<AvatarFallback className="bg-secondary text-xs font-bold text-secondary-foreground">
				{initials}
			</AvatarFallback>
		</Avatar>
	);
}

/** A pod taken apart: pick a part to see what it is and how it fits. */
export function PodMap() {
	const [picked, setPicked] = useState<Part>("people");
	const bots = [cast.tripPlanner, cast.budgetKeeper];

	return (
		<Card className="my-8 gap-0 rounded-3xl py-0 shadow-xl">
			<div className="flex items-center gap-3 border-b px-5 py-4">
				<PodIcon tint="sky" bots={["sky", "yellow", "teal"]} />
				<div className="flex flex-col">
					<span className="font-bold">Family</span>
					<span className="text-xs text-muted-foreground">A shared pod</span>
				</div>
			</div>
			<div className="grid gap-3 bg-muted/40 p-4 sm:grid-cols-2">
				<Region part="people" picked={picked}>
					<div className="flex gap-2">
						<PersonFace initials="YOU" />
						<PersonFace initials={cast.mum.initials} />
						<PersonFace initials={cast.dad.initials} />
						<PersonFace initials={cast.sam.initials} />
					</div>
				</Region>
				<Region part="bots" picked={picked}>
					<div className="flex flex-col gap-2">
						{bots.map((bot) => (
							<span key={bot.name} className="flex items-center gap-2 text-sm font-semibold">
								<BotAvatar {...bot.look} />
								{bot.name}
							</span>
						))}
					</div>
				</Region>
				<Region part="chats" picked={picked}>
					<div className="flex flex-col gap-2">
						{bots.map((bot) => (
							<span key={bot.name} className="flex items-center gap-2 text-sm">
								<MessagesSquareIcon className="size-4 text-muted-foreground" />
								Chat with {bot.name}
							</span>
						))}
					</div>
				</Region>
				<Region part="connections" picked={picked}>
					<div className="flex flex-wrap gap-2">
						{["Notion", "Linear"].map((app) => (
							<span
								key={app}
								className="flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1 text-sm font-semibold"
							>
								<PlugIcon className="size-3.5" />
								{app}
							</span>
						))}
					</div>
				</Region>
			</div>
			<div className="flex flex-col gap-4 border-t px-5 py-4">
				<div role="tablist" aria-label="Parts of a pod" className="flex flex-wrap gap-2">
					{(Object.keys(parts) as Part[]).map((part) => (
						<button
							key={part}
							type="button"
							role="tab"
							aria-selected={part === picked}
							onClick={() => setPicked(part)}
							className={cn(
								"rounded-full border-2 px-3.5 py-1 text-sm font-semibold transition-colors",
								part === picked
									? "border-brand bg-brand text-brand-foreground"
									: "border-input text-muted-foreground hover:border-muted-foreground hover:text-foreground",
							)}
						>
							{parts[part].label}
						</button>
					))}
				</div>
				<div role="tabpanel" className="min-h-12">
					<AnimatePresence mode="wait" initial={false}>
						<motion.p
							key={picked}
							variants={riseIn}
							initial="hidden"
							animate="visible"
							exit="hidden"
							className="text-pretty"
						>
							{parts[picked].explanation}
						</motion.p>
					</AnimatePresence>
				</div>
			</div>
		</Card>
	);
}
