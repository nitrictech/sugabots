import type { Bot, BotParticipant, ChatDetails, Project } from "@sugabots/contracts";
import type { ChatLocation } from "@/lib/chats.ts";
import { BotAvatar } from "@/shell/Bot.tsx";
import { ProjectInitial } from "@/shell/SidebarProject.tsx";
import { leadOf } from "./chat-location.ts";

/**
 * The top of a chat, once there is nothing older to load: what it is
 * and who is in it, as each kind says it.
 */
export function ChatIntro({
	chatLocation,
	projectChatName,
	details,
}: {
	chatLocation: ChatLocation;
	/** What a project's chat is called, as its project lists it. */
	projectChatName: string;
	details: ChatDetails;
}) {
	if (details.chat.kind === "automation_feed") {
		return <AutomationFeedIntro title={details.chat.title} lead={leadOf(chatLocation, details)} />;
	}
	if ("project" in chatLocation) {
		return <ProjectChatIntro project={chatLocation.project} name={projectChatName} />;
	}
	return <BotChatIntro bot={chatLocation.bot} title={details.chat.title} />;
}

/** The top of an automation's feed: what the automation is called, and the bot that runs it, its project's lead. */
function AutomationFeedIntro({ title, lead }: { title: string; lead: BotParticipant | undefined }) {
	return (
		<div className="flex flex-col gap-1.5 px-5 pt-6 pb-4">
			<h2 className="m-0 font-bold text-xl text-foreground leading-tight">{title}</h2>
			<p className="m-0 text-xs text-muted-foreground">
				{lead && `Runs as ${lead.name}. `}Each run posts here.
			</p>
		</div>
	);
}

/** The top of a project's chat: what it is about, and the project it is in. */
function ProjectChatIntro({ project, name }: { project: Project; name: string }) {
	return (
		<div className="flex flex-col gap-2 px-5 pt-2 pb-3.5">
			<h2 className="m-0 font-bold text-2xl text-foreground leading-tight tracking-normal text-balance max-md:text-xl">
				{name}
			</h2>
			<p className="m-0 flex max-w-xl items-center gap-2 text-sm text-muted-foreground leading-normal">
				<ProjectInitial project={project} />
				In {project.name}
			</p>
		</div>
	);
}

/** The top of a bot's chat: what it is about, with whom, or, before it has a name, whom it is with. */
function BotChatIntro({ bot, title }: { bot: Bot; title: string | undefined }) {
	// A bot's chat is about something, so its name leads and the bot is beside it, smaller.
	if (title) {
		return (
			<div className="flex flex-col gap-2 px-5 pt-2 pb-3.5">
				<h2 className="m-0 font-bold text-2xl text-foreground leading-tight tracking-normal text-balance max-md:text-xl">
					{title}
				</h2>
				<p className="m-0 flex max-w-xl items-center gap-2 text-sm text-muted-foreground leading-normal">
					<BotAvatar color={bot.color} eyes={bot.eyes} shape={bot.shape} size={20} />
					With {bot.name}
				</p>
			</div>
		);
	}
	return (
		<div className="flex flex-col gap-2 px-5 pt-2 pb-3.5">
			<BotAvatar color={bot.color} eyes={bot.eyes} shape={bot.shape} size={64} />
			<h2 className="m-0 pt-1 font-bold text-2xl text-foreground tracking-normal">{bot.name}</h2>
			<p className="m-0 max-w-xl text-sm text-muted-foreground leading-normal">
				This is the start of your chat with {bot.name}.{bot.description && ` ${bot.description}`}
			</p>
		</div>
	);
}
