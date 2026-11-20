import {
	type BotParticipant,
	type BotStartedThread,
	botStartedThreadSchema,
	type Message,
	type Participant,
	START_THREAD_TOOL,
} from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { Option, Schema } from "effect";
import { ChevronRight } from "lucide-react";
import { threadByIdLink } from "@/lib/links.ts";
import { BotAvatar } from "@/shell/Bot.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";

/**
 * A thread a bot started with `start_thread` in its reply, shown from the call,
 * hanging off the reply that names it: a curve down from the reply, the faces
 * of who started it and the other bot it is with, when that bot is among
 * `projectBots`, and its title. The whole line opens the thread, by its id
 * alone: the bot it is with may be outside this project, and its route finds it.
 */
export function BotStartedThreadLine({
	started,
	startedBy,
	projectBots,
}: {
	started: BotStartedThread;
	startedBy: Message["author"];
	projectBots: readonly BotParticipant[];
}) {
	const otherBot = started.withBotId
		? projectBots.find((member) => member.id === started.withBotId)
		: undefined;
	const faces = [
		...(startedBy.kind === "automation_trigger" ? [] : [startedBy]),
		...(otherBot ? [otherBot] : []),
	];
	return (
		<Link
			{...threadByIdLink(started.id)}
			aria-label={`Open thread: ${started.title}`}
			// On a phone, a whole row for a thumb, with a chevron.
			className="focus-ring group/side mt-1 ml-2 flex max-w-full items-center gap-2 rounded-md pr-1.5 text-left max-md:min-h-11 max-md:w-conversation-line max-md:gap-2.5 max-md:rounded-lg max-md:active:bg-row-selected"
		>
			<span
				aria-hidden
				className="-mt-1 h-4 w-2.5 shrink-0 self-start rounded-bl-sm border-border-dashed border-b border-l max-md:h-5"
			/>
			<span aria-hidden className="flex shrink-0 py-1 pr-0.5">
				{faces.map((face) => (
					<LineFace key={face.id} face={face} />
				))}
			</span>
			<span className="min-w-0 truncate font-semibold text-xs text-foreground group-hover/side:underline group-hover/side:underline-offset-2 max-md:flex-1 max-md:text-sm">
				{started.title}
			</span>
			<ChevronRight
				aria-hidden
				size={16}
				strokeWidth={2}
				className="shrink-0 text-disabled-foreground md:hidden"
			/>
		</Link>
	);
}

/** One face on the line, ringed so it reads apart from the one before it, which it overlaps. */
function LineFace({ face }: { face: Participant }) {
	return face.kind === "bot" ? (
		<BotAvatar
			color={face.color}
			face={face.face}
			shape={face.shape}
			size={16}
			ringed={{ color: "var(--background)", width: 1.5 }}
			// Positioned, as a person's face is, so each face sits over the one before it.
			className="relative -mr-0.5 max-md:-mr-1.5 max-md:size-5.5"
		/>
	) : (
		<PersonAvatar
			person={face}
			size={16}
			className="-mr-0.5 ring-2 ring-background max-md:-mr-1.5 max-md:size-5.5! max-md:text-3xs!"
		/>
	);
}

const decodeStartThreadOutput = Schema.decodeUnknownOption(
	Schema.Union([
		Schema.Struct({ thread: botStartedThreadSchema }),
		// What calls recorded as `start_task` answered.
		Schema.Struct({ task: botStartedThreadSchema }),
	]),
);

/** The name some recorded calls of `start_thread` have. */
const START_TASK_TOOL = "start_task";

/** The threads a bot's message started with `start_thread`, in the order it started them. */
export function threadsStartedBy(message: Message): BotStartedThread[] {
	return message.parts.flatMap((part) => {
		if (part.type !== "tool_call") return [];
		if (part.tool !== START_THREAD_TOOL && part.tool !== START_TASK_TOOL) return [];
		if (part.status !== "completed") return [];
		return Option.match(decodeStartThreadOutput(part.output), {
			onNone: () => [],
			onSome: (output) => ["thread" in output ? output.thread : output.task],
		});
	});
}
