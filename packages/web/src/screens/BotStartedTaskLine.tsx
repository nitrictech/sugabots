import {
	type Bot,
	type BotStartedTask,
	botStartedTaskSchema,
	type Message,
	type Participant,
	START_TASK_TOOL,
} from "@sugabots/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Option, Schema } from "effect";
import { conversationLink } from "@/lib/links.ts";
import { SideConversationLine } from "./SideConversationLine.tsx";

/**
 * A task a bot started with `start_task` in its reply, shown from the call,
 * under the reply that names it. Opens the task with whichever bot it is with:
 * the other bot it names among `channelBots`, else the chat's own, `bot`.
 */
export function BotStartedTaskLine({
	started,
	startedBy,
	channelBots,
	bot,
}: {
	started: BotStartedTask;
	startedBy: Message["author"];
	channelBots: readonly Participant[];
	/** The chat's own bot; null in a channel. */
	bot: Bot | null;
}) {
	const navigate = useNavigate();
	const otherBot = started.withBotId
		? channelBots.find((member) => member.id === started.withBotId)
		: undefined;
	const faces = [
		...(startedBy.kind === "automation_trigger" ? [] : [startedBy]),
		...(otherBot ? [otherBot] : []),
	];
	const withBot = otherBot ?? bot;
	return (
		<SideConversationLine
			faces={faces}
			label={started.title}
			description={`Open task: ${started.title}`}
			onOpen={() => {
				if (!withBot) return;
				void navigate(conversationLink({ bot: withBot, conversationId: started.id }));
			}}
		/>
	);
}

const decodeStartTaskOutput = Schema.decodeUnknownOption(
	Schema.Union([
		Schema.Struct({ task: botStartedTaskSchema }),
		// What the tool answered under its name before tasks were called that, which earlier calls record.
		Schema.Struct({ thread: botStartedTaskSchema }),
	]),
);

/** The tool's name before tasks were called that, which earlier calls record. */
const START_THREAD_TOOL = "start_thread";

/** The tasks a bot's message started with `start_task`, in the order it started them. */
export function tasksStartedBy(message: Message): BotStartedTask[] {
	return message.parts.flatMap((part) => {
		if (part.type !== "tool_call") return [];
		if (part.tool !== START_TASK_TOOL && part.tool !== START_THREAD_TOOL) return [];
		if (part.status !== "completed") return [];
		return Option.match(decodeStartTaskOutput(part.output), {
			onNone: () => [],
			onSome: (output) => ["task" in output ? output.task : output.thread],
		});
	});
}
