import {
	type BotParticipant,
	type BotStartedChat,
	type Message,
	START_CHAT_TOOL,
} from "@sugabots/contracts";
import { operationContracts } from "@sugabots/contracts/operations";
import { Link } from "@tanstack/react-router";
import { Option, Schema } from "effect";
import { ChevronRight } from "lucide-react";
import { chatByIdLink } from "@/lib/links.ts";
import { BotAvatar } from "@/shell/Bot.tsx";

/**
 * A chat a bot started with `start_chat` in its reply, shown from the call,
 * hanging off the reply that names it: a curve down from the reply, the faces
 * of the bot that started it and the other bot it is with, when that bot is among
 * `projectBots`, and its title. The whole line opens the chat, by its id
 * alone: the bot it is with may be outside this project, and its route finds it.
 */
export function BotStartedChatLine({
	started,
	startedBy,
	projectBots,
}: {
	started: BotStartedChat;
	startedBy: BotParticipant;
	projectBots: readonly BotParticipant[];
}) {
	const otherBot = started.withBotId
		? projectBots.find((bot) => bot.id === started.withBotId)
		: undefined;
	const faces = otherBot ? [startedBy, otherBot] : [startedBy];
	return (
		<Link
			{...chatByIdLink(started.id)}
			aria-label={`Open chat: ${started.title}`}
			// On a phone, a whole row for a thumb, with a chevron.
			className="focus-ring group/side mt-1 ml-2 flex max-w-full items-center gap-2 rounded-md pr-1.5 text-left max-md:min-h-11 max-md:w-chat-line max-md:gap-2.5 max-md:rounded-lg max-md:active:bg-row-selected"
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

/** One bot's face on the line, ringed so it reads apart from the one before it, which it overlaps. */
function LineFace({ face }: { face: BotParticipant }) {
	return (
		<BotAvatar
			color={face.color}
			eyes={face.eyes}
			shape={face.shape}
			size={16}
			ringed={{ color: "var(--background)", width: 1.5 }}
			// Positioned, so each face sits over the one before it.
			className="relative -mr-0.5 max-md:-mr-1.5 max-md:size-6"
		/>
	);
}

const decodeStartChatOutput = Schema.decodeUnknownOption(
	operationContracts["chats.startBriefedChat"].output,
);

/** The chats a bot's message started with `start_chat`, in the order it started them. */
export function chatsStartedBy(message: Message): BotStartedChat[] {
	return message.parts.flatMap((part) => {
		if (part.type !== "tool_call") return [];
		if (part.tool !== START_CHAT_TOOL) return [];
		if (part.status !== "completed") return [];
		return Option.match(decodeStartChatOutput(part.output), {
			onNone: () => [],
			onSome: (output) => [output.chat],
		});
	});
}
