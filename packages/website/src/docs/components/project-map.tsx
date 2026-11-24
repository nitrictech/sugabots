import { cn } from "cn";
import { FileTextIcon, HashIcon, MessagesSquareIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useState } from "react";
import { cast } from "@/cast";
import { BotAvatar } from "@/components/bot-avatar";
import { ChatAvatar } from "@/components/chat";
import { DemoCard } from "@/components/demo-card";
import { riseIn } from "@/components/reveal";
import { ChoiceChips } from "@/components/ui/choice-chips";

const parts = {
	members: {
		label: "Members",
		explanation:
			"Everyone in the project sees its chats and files, and anyone in it but a viewer can invite more members. Anyone can find a public project and join it; a private one is invitation only.",
	},
	bots: {
		label: "Bots",
		explanation:
			"Public bots, added by the project's members. Its lead bot answers its chats; the others answer when mentioned, or when you reply to them, and any of them can ask another bot for help.",
	},
	chats: {
		label: "Chats",
		explanation:
			"The project's chats, listed in its own sidebar, the most recently active first. The project is made of them: each is one chat about one piece of work, with all its members and bots.",
	},
	files: {
		label: "Files",
		explanation:
			"Everything uploaded or made in the project's chats, kept in one place for the whole project.",
	},
} as const;

type Part = keyof typeof parts;

const partLabels = Object.fromEntries(
	Object.entries(parts).map(([part, { label }]) => [part, label]),
) as Record<Part, string>;

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

/** A project taken apart: pick a part to see what it is and how it fits. */
export function ProjectMap() {
	const [picked, setPicked] = useState<Part>("members");
	const members = [cast.you, cast.mum, cast.dad, cast.sam];
	const bots = [cast.tripPlanner, cast.budgetKeeper];

	return (
		<DemoCard>
			<div className="flex items-center gap-3 border-b px-5 py-4">
				<span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-secondary text-secondary-foreground">
					<HashIcon className="size-5" />
				</span>
				<div className="flex flex-col">
					<span className="font-bold">Family</span>
					<span className="text-xs text-muted-foreground">A private project</span>
				</div>
			</div>
			<div className="grid gap-3 bg-muted/40 p-4 sm:grid-cols-2">
				<Region part="members" picked={picked}>
					<div className="flex gap-2">
						{members.map((member) => (
							<ChatAvatar key={member.name} author={member} size="lg" />
						))}
					</div>
				</Region>
				<Region part="bots" picked={picked}>
					<div className="flex flex-col gap-2">
						{bots.map((bot) => (
							<span key={bot.name} className="flex items-center gap-2 text-sm font-semibold">
								<BotAvatar {...bot.avatar} />
								{bot.name}
							</span>
						))}
					</div>
				</Region>
				<Region part="chats" picked={picked}>
					<div className="flex flex-col gap-2">
						{["Lisbon trip", "Nan's birthday", "Bins rota"].map((chat) => (
							<span key={chat} className="flex items-center gap-2 text-sm">
								<MessagesSquareIcon className="size-4 text-muted-foreground" />
								{chat}
							</span>
						))}
					</div>
				</Region>
				<Region part="files" picked={picked}>
					<div className="flex flex-wrap gap-2">
						{["Lisbon itinerary", "Holiday budget"].map((file) => (
							<span
								key={file}
								className="flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1 text-sm font-semibold"
							>
								<FileTextIcon className="size-3.5" />
								{file}
							</span>
						))}
					</div>
				</Region>
			</div>
			<div className="flex flex-col gap-4 border-t px-5 py-4">
				<ChoiceChips
					label="Parts of a project"
					labelClassName="sr-only"
					tone="brand"
					options={partLabels}
					value={picked}
					onChange={setPicked}
				/>
				<div className="min-h-12">
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
		</DemoCard>
	);
}
