import type { Bot, Channel, ConversationDetails } from "@sugabots/contracts";
import {
	type ConversationPlaceKind,
	type DirectPeople,
	directPeopleNames,
	directPeopleTitle,
	isOneToOne,
} from "@/lib/chats.ts";
import { countOf } from "@/lib/name-list.ts";
import { BotAvatar } from "@/shell/Bot.tsx";
import { ChannelConversationTile } from "@/shell/ChannelConversationTile.tsx";
import { DirectPeopleAvatar } from "@/shell/DirectMessages.tsx";

/**
 * The top of a conversation, once there is nothing older to load: what it is
 * and who is in it, as each kind says it.
 */
export function ConversationIntro({
	conversation,
	channel,
	channelConversationName,
	details,
}: {
	conversation: ConversationPlaceKind;
	channel: Channel | null;
	/** What a channel's conversation is called, as its channel lists it. */
	channelConversationName: string;
	details: ConversationDetails;
}) {
	if (conversation.kind === "channelConversation") {
		return (
			channel && (
				<ChannelConversationIntro
					channel={channel}
					name={channelConversationName}
					details={details}
				/>
			)
		);
	}
	if (conversation.kind === "directMessage") return <DirectMessageIntro {...conversation} />;
	if (details.conversation.kind === "automation_feed") {
		return <AutomationFeedIntro title={details.conversation.title} bot={conversation.bot} />;
	}
	return <TaskIntro bot={conversation.bot} title={details.conversation.title} />;
}

/** The top of an automation's feed: what the automation is called, and the bot that runs it. */
function AutomationFeedIntro({ title, bot }: { title: string; bot: Bot }) {
	return (
		<div className="flex flex-col gap-1.5 px-5 pt-6 pb-4">
			<h2 className="m-0 font-bold text-xl text-foreground leading-tight">{title}</h2>
			<p className="m-0 text-xs text-muted-foreground">Runs as {bot.name}. Each run posts here.</p>
		</div>
	);
}

/** The top of a channel's main chat or thread: how many are in it, and what it is for. */
function ChannelConversationIntro({
	channel,
	name,
	details,
}: {
	channel: Channel;
	name: string;
	details: ConversationDetails;
}) {
	const people = details.members.length;
	const bots = details.channelBots.filter((member) => member.kind === "bot").length;
	return (
		<div className="flex flex-col gap-2 px-5 pt-2 pb-3.5">
			<ChannelConversationTile color={channel.color} size={64} />
			<h2 className="m-0 pt-1 font-bold text-2xl text-foreground tracking-normal">{name}</h2>
			<p className="m-0 max-w-140 text-sm text-muted-foreground leading-normal">
				This is the start of {name}, with {countOf(people, "person", "people")} and{" "}
				{countOf(bots, "bot", "bots")}. Talk here, and mention a bot to have it reply.
			</p>
		</div>
	);
}

/** The top of a task: what it is about, with whom, or, before it has a name, whom it is with. */
function TaskIntro({ bot, title }: { bot: Bot; title: string | undefined }) {
	// A task is about something, so its name leads and the bot is beside it, smaller.
	if (title) {
		return (
			<div className="flex flex-col gap-2 px-5 pt-2 pb-3.5">
				<h2 className="m-0 font-bold text-2xl text-foreground leading-tight tracking-normal text-balance max-md:text-xl">
					{title}
				</h2>
				<p className="m-0 flex max-w-140 items-center gap-2 text-sm text-muted-foreground leading-normal">
					<BotAvatar color={bot.color} face={bot.face} shape={bot.shape} size={20} />
					With {bot.name}
				</p>
			</div>
		);
	}
	return (
		<div className="flex flex-col gap-2 px-5 pt-2 pb-3.5">
			<BotAvatar color={bot.color} face={bot.face} shape={bot.shape} size={64} />
			<h2 className="m-0 pt-1 font-bold text-2xl text-foreground tracking-normal">{bot.name}</h2>
			<p className="m-0 max-w-140 text-sm text-muted-foreground leading-normal">
				This is the start of your task with {bot.name}.{bot.description && ` ${bot.description}`}
			</p>
		</div>
	);
}

/** The top of a direct message between people: whom it is with, and that only the people in it see it. */
function DirectMessageIntro(direct: DirectPeople) {
	const name = directPeopleTitle(direct);
	const description =
		direct.people.length === 0
			? "They have left the workspace, so they won't see anything new here."
			: isOneToOne(direct)
				? `This is the start of your direct messages with ${name}. Only the two of you can see them.`
				: `This is a private conversation between ${everyoneNamed(directPeopleNames(direct))}. Only the people here can see it.`;
	return (
		<div className="flex flex-col gap-2 px-5 pt-2 pb-3.5">
			<DirectPeopleAvatar {...direct} size={64} />
			<h2 className="m-0 pt-1 font-bold text-2xl text-foreground tracking-tight text-balance">
				{name}
			</h2>
			<p className="m-0 max-w-140 text-sm text-muted-foreground leading-normal">{description}</p>
		</div>
	);
}

/** Everyone in a direct message, `others` then you, each named, however many: "A, B and you". */
function everyoneNamed(others: readonly string[]): string {
	return `${others.join(", ")} and you`;
}
