import type { Bot, ConversationDetails, Project } from "@sugabots/contracts";
import {
	type DirectPeople,
	directPeopleNames,
	directPeopleTitle,
	isOneToOne,
} from "@/lib/chats.ts";
import { listNames } from "@/lib/name-list.ts";
import { BotAvatar } from "@/shell/Bot.tsx";
import { DirectPeopleAvatar } from "@/shell/DirectMessages.tsx";
import { ProjectInitial } from "@/shell/SidebarProject.tsx";
import type { AnyConversationPlace } from "./conversation-place.ts";

/**
 * The top of a conversation, once there is nothing older to load: what it is
 * and who is in it, as each kind says it.
 */
export function ConversationIntro({
	conversationPlace,
	projectThreadName,
	details,
}: {
	conversationPlace: AnyConversationPlace;
	/** What a project's thread is called, as its project lists it. */
	projectThreadName: string;
	details: ConversationDetails;
}) {
	if (conversationPlace.project) {
		return <ProjectThreadIntro project={conversationPlace.project} name={projectThreadName} />;
	}
	const { conversation } = conversationPlace;
	if (conversation.kind === "directMessage") return <DirectMessageIntro {...conversation} />;
	if (details.conversation.kind === "automation_feed") {
		return <AutomationFeedIntro title={details.conversation.title} bot={conversation.bot} />;
	}
	return <ThreadIntro bot={conversation.bot} title={details.conversation.title} />;
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

/** The top of a project's thread: what it is about, and the project it is in. */
function ProjectThreadIntro({ project, name }: { project: Project; name: string }) {
	return (
		<div className="flex flex-col gap-2 px-5 pt-2 pb-3.5">
			<h2 className="m-0 font-bold text-2xl text-foreground leading-tight tracking-normal text-balance max-md:text-xl">
				{name}
			</h2>
			<p className="m-0 flex max-w-140 items-center gap-2 text-sm text-muted-foreground leading-normal">
				<ProjectInitial project={project} />
				In {project.name}
			</p>
		</div>
	);
}

/** The top of a bot's thread: what it is about, with whom, or, before it has a name, whom it is with. */
function ThreadIntro({ bot, title }: { bot: Bot; title: string | undefined }) {
	// A bot's thread is about something, so its name leads and the bot is beside it, smaller.
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
				This is the start of your thread with {bot.name}.{bot.description && ` ${bot.description}`}
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
				: `This is a private conversation between ${listNames([...directPeopleNames(direct), "you"], { maxNamed: Number.POSITIVE_INFINITY })}. Only the people here can see it.`;
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
