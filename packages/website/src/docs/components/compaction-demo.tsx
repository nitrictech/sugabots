import type { BotLook } from "@sugabots/avatars";
import { cn } from "cn";
import { ChevronLeftIcon, ChevronRightIcon, PauseIcon, PlayIcon, SearchIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { BotAvatar } from "@/components/bot-avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { type CastName, cast } from "@/docs/cast";
import { Say } from "@/docs/components/chat-demo";

/** How the system agent that compacts a bot's history looks, as packages/core/src/workspaces/agents/system-agents.ts defines it. */
const compactorLook: BotLook = { color: "purple", face: "square" };

/** Where a message ends up once the chat has been compacted. */
type Band =
	/** Older than what the first compaction summarises: left out of what the bot reads, but it can search for it. */
	| "left-out"
	/** Folded into the summary at the head of what the bot reads. */
	| "summarised"
	/** Kept word for word. */
	| "kept";

interface Line {
	from: CastName;
	time: string;
	text: string;
	band: Band;
}

/**
 * Where the messages the bot reads word for word start, as the summary gives
 * it: the day as well as the time, since long chats span days. Everything
 * before it can be searched.
 */
const KEPT_FROM = "Thu 15 May 2026, 18:30";

const lines: readonly Line[] = [
	{
		from: "mum",
		time: "17:02",
		text: "Lisbon in May? Hotels under €150 a night, please.",
		band: "left-out",
	},
	{
		from: "tripPlanner",
		time: "17:05",
		text: "Noted: under €150 a night.",
		band: "left-out",
	},
	{
		from: "dad",
		time: "17:31",
		text: "Friday the 16th to Monday works for me.",
		band: "left-out",
	},
	{
		from: "tripPlanner",
		time: "17:33",
		text: "Friday 16th to Monday 19th it is.",
		band: "left-out",
	},
	{ from: "you", time: "17:48", text: "Can you find flights Friday after 5?", band: "summarised" },
	{
		from: "tripPlanner",
		time: "17:52",
		text: "Two options under €180 each: 17:55 and 18:40.",
		band: "summarised",
	},
	{
		from: "dad",
		time: "18:10",
		text: "18:40. Nobody is doing a 6am flight again.",
		band: "summarised",
	},
	{
		from: "tripPlanner",
		time: "18:21",
		text: "Holding the 18:40 for four. €220 left in the pot.",
		band: "summarised",
	},
	{ from: "sam", time: "18:30", text: "Can I have a window seat?", band: "kept" },
	{ from: "tripPlanner", time: "18:32", text: "Asked for a window seat for Sam.", band: "kept" },
	{ from: "you", time: "18:45", text: "Now find us a hotel near the river.", band: "kept" },
	{
		from: "tripPlanner",
		time: "18:46",
		text: "Three by the river, all under Mum's €150 a night.",
		band: "kept",
	},
];

const summary = [
	"Decisions: On 15 May, Dad chose the 18:40 flight on Friday 16th, and Trip Planner held it for four.",
	"Key facts: €220 left in the pot.",
	`This covers the chat up to ${KEPT_FROM}. Anything it leaves out can be searched.`,
];

interface Step {
	title: string;
	caption: string;
	/** How many of `lines` have been said by this step. */
	said: number;
	/** How full the bot's context window is, as a percentage. */
	contextUsed: number;
	compaction: "idle" | "working" | "done";
	/** Whether the bot searched the messages it no longer reads. */
	searchedBack?: boolean;
}

const steps: readonly Step[] = [
	{
		title: "The chat grows",
		caption:
			"Every time it replies, Trip Planner rereads the whole chat, so each message takes up a little more room.",
		said: 4,
		contextUsed: 22,
		compaction: "idle",
	},
	{
		title: "Filling up",
		caption: "The longer the chat, the more of Trip Planner's short-term memory it fills.",
		said: 7,
		contextUsed: 62,
		compaction: "idle",
	},
	{
		title: "Nearly full",
		caption:
			"The chat has filled most of Trip Planner's short-term memory, so Sugabots starts compacting it in the background. Nobody waits for it.",
		said: 8,
		contextUsed: 73,
		compaction: "working",
	},
	{
		title: "Still room to talk",
		caption: "There's still room to spare, so the chat carries on in the meantime.",
		said: 10,
		contextUsed: 81,
		compaction: "working",
	},
	{
		title: "Compacted",
		caption:
			"Trip Planner now rereads a short summary, then the latest messages word for word. Everyone still sees the whole chat.",
		said: 10,
		contextUsed: 26,
		compaction: "done",
	},
	{
		title: "Looking further back",
		caption:
			"Mum's budget isn't in the summary, so Trip Planner searches the earlier messages and finds it.",
		said: 12,
		contextUsed: 33,
		compaction: "done",
		searchedBack: true,
	},
];

/** Where compaction starts, and the model's hard limit, as percentages of the context window. */
const COMPACTION_LINE = 70;
const CONTEXT_LIMIT = 100;

/** How long each step stays up while playing. */
const STEP_MS = 3200;

/** Steps through how a long chat gets compacted: what people see, and what the bot reads. */
export function CompactionDemo() {
	const [index, setIndex] = useState(0);
	const [playing, setPlaying] = useState(false);
	const step = steps[index] ?? steps[0];
	const lastIndex = steps.length - 1;

	useEffect(() => {
		if (!playing) return;
		if (index === lastIndex) {
			setPlaying(false);
			return;
		}
		const timer = setTimeout(() => setIndex(index + 1), STEP_MS);
		return () => clearTimeout(timer);
	}, [playing, index, lastIndex]);

	if (!step) return null;

	function togglePlaying() {
		if (!playing && index === lastIndex) setIndex(0);
		setPlaying(!playing);
	}

	function goTo(next: number) {
		setPlaying(false);
		setIndex(next);
	}

	return (
		<Card className="my-8 gap-0 rounded-3xl py-0 shadow-xl">
			<div className="flex flex-wrap items-center gap-2 border-b px-5 py-3">
				<span className="flex-1 text-sm font-semibold">
					{index + 1}. {step.title}
				</span>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Previous step"
					disabled={index === 0}
					onClick={() => goTo(index - 1)}
				>
					<ChevronLeftIcon />
				</Button>
				<Button variant="secondary" size="sm" onClick={togglePlaying}>
					{playing ? <PauseIcon data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}
					{playing ? "Pause" : "Play"}
				</Button>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Next step"
					disabled={index === lastIndex}
					onClick={() => goTo(index + 1)}
				>
					<ChevronRightIcon />
				</Button>
			</div>

			<div className="grid grid-cols-1 md:grid-cols-2 md:divide-x">
				<PeopleView said={step.said} />
				<BotView step={step} />
			</div>

			<p aria-live="polite" className="m-4 mt-0 rounded-2xl bg-muted px-4 py-3 text-sm text-pretty">
				{step.caption}
			</p>
		</Card>
	);
}

function PanelTitle({ children }: { children: string }) {
	return (
		<h3 className="text-xs font-bold tracking-wide text-muted-foreground uppercase">{children}</h3>
	);
}

/** The chat as people see it: every message, however long it gets. */
function PeopleView({ said }: { said: number }) {
	return (
		<div className="flex flex-col gap-3 p-4 sm:p-5">
			<PanelTitle>What everyone sees</PanelTitle>
			<div className="relative flex h-72 flex-col justify-end md:h-96 gap-3 overflow-hidden">
				<div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-12 bg-linear-to-b from-card" />
				<AnimatePresence initial={false}>
					{lines.slice(0, said).map((line) => (
						<motion.div
							key={line.time}
							layout
							initial={{ opacity: 0, y: 12 }}
							animate={{ opacity: 1, y: 0 }}
						>
							<Say from={line.from}>{line.text}</Say>
						</motion.div>
					))}
				</AnimatePresence>
			</div>
		</div>
	);
}

/** What the bot reads on its next turn, and how much of its context window that fills. */
function BotView({ step }: { step: Step }) {
	const compacted = step.compaction === "done";
	const read = lines.slice(0, step.said).filter((line) => !compacted || line.band === "kept");

	return (
		<div className="flex flex-col gap-3 border-t p-4 sm:p-5 md:border-t-0">
			<PanelTitle>What Trip Planner reads</PanelTitle>
			<ContextMeter used={step.contextUsed} />
			<CompactionStatus state={step.compaction} />
			<div className="flex h-72 flex-col gap-1.5 overflow-hidden">
				<AnimatePresence initial={false} mode="popLayout">
					{compacted && <SummaryHead key="summary" />}
					{read.map((line) => (
						<motion.div
							key={line.time}
							layout
							initial={{ opacity: 0, x: 12 }}
							animate={{ opacity: 1, x: 0 }}
							exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.35 } }}
						>
							{step.searchedBack && line === lines[lines.length - 1] && <SearchedBack />}
							<ReadLine line={line} />
						</motion.div>
					))}
				</AnimatePresence>
			</div>
		</div>
	);
}

function ReadLine({ line }: { line: Line }) {
	return (
		<p className="truncate rounded-xl bg-muted/60 px-3 py-1.5 text-xs">
			<span className="font-semibold">{cast[line.from].name}</span>{" "}
			<span className="text-muted-foreground">{line.text}</span>
		</p>
	);
}

/** The summary at the head of the bot's history. */
function SummaryHead() {
	return (
		<motion.div
			layout
			initial={{ opacity: 0, scale: 0.9 }}
			animate={{ opacity: 1, scale: 1 }}
			className="flex items-start gap-2.5 rounded-xl border-2 border-dashed border-input px-3 py-2"
		>
			<BotAvatar size="sm" {...compactorLook} />
			<span className="flex flex-col gap-0.5 text-xs">
				<span className="font-semibold">Summary</span>
				{summary.map((paragraph) => (
					<span key={paragraph} className="text-muted-foreground text-pretty">
						{paragraph}
					</span>
				))}
			</span>
		</motion.div>
	);
}

function SearchedBack() {
	return (
		<motion.p
			initial={{ opacity: 0 }}
			animate={{ opacity: 1 }}
			className="mb-1.5 flex items-center gap-1.5 px-1 text-xs font-semibold text-muted-foreground"
		>
			<SearchIcon className="size-3.5" />
			Searched earlier messages for “hotel budget”
		</motion.p>
	);
}

function CompactionStatus({ state }: { state: Step["compaction"] }) {
	const text = {
		idle: "Nothing to compact yet",
		working: "Compacting in the background…",
		done: "Compacted",
	}[state];
	return (
		<div className="flex items-center gap-2 text-xs font-semibold">
			<motion.span
				animate={state === "working" ? { rotate: [0, -8, 8, 0] } : { rotate: 0 }}
				transition={state === "working" ? { repeat: Infinity, duration: 1.2 } : undefined}
				className={cn(state === "idle" && "opacity-40")}
			>
				<BotAvatar size="xs" {...compactorLook} />
			</motion.span>
			<span className={cn(state === "idle" && "text-muted-foreground")}>{text}</span>
		</div>
	);
}

/** How full the context window is, with the compaction line and the limit marked. */
function ContextMeter({ used }: { used: number }) {
	return (
		<div className="flex flex-col gap-1">
			<meter
				className="sr-only"
				aria-label="Short-term memory used"
				value={used}
				max={CONTEXT_LIMIT}
			/>
			<div aria-hidden className="relative h-3 overflow-hidden rounded-full bg-muted">
				<div
					className="absolute inset-y-0 right-0 bg-destructive/15"
					style={{ left: `${COMPACTION_LINE}%` }}
				/>
				<motion.div
					className={cn(
						"absolute inset-y-0 left-0 rounded-full",
						used >= COMPACTION_LINE ? "bg-destructive" : "bg-brand",
					)}
					animate={{ width: `${used}%` }}
					transition={{ type: "spring", stiffness: 120, damping: 20 }}
				/>
				<div
					className="absolute inset-y-0 w-0.5 bg-foreground"
					style={{ left: `${COMPACTION_LINE}%` }}
				/>
			</div>
			<div className="relative h-4 text-[0.7rem] font-semibold text-muted-foreground">
				<span className="absolute left-0">Short-term memory</span>
				<span className="absolute -translate-x-1/2" style={{ left: `${COMPACTION_LINE}%` }}>
					Compact
				</span>
				<span className="absolute right-0">Full</span>
			</div>
		</div>
	);
}
