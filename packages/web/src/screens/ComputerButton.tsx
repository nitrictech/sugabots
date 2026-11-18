import type { Bot } from "@sugabots/contracts";
import { Monitor } from "lucide-react";
import { useComputerAccess } from "@/lib/computer-providers.ts";
import { useDesktopInUse } from "@/lib/desktop.ts";
import { HeaderButton } from "./HeaderButton.tsx";

/**
 * The bot's computer, for the top of its chat: always there, so it opens to
 * say how to get one when the workspace or the bot has none.
 */
export function ChatComputer({
	bot,
	conversationId,
	onOpen,
}: {
	bot: Bot;
	/** The conversation the bot's desktop is watched from. */
	conversationId: string;
	onOpen: () => void;
}) {
	const computersOn = useComputerAccess().data?.enabled === true;
	const inUse = useDesktopInUse(conversationId, bot.id);
	return (
		<ComputerButton
			botName={bot.name}
			inUse={bot.usesComputer && computersOn && inUse}
			onOpen={onOpen}
		/>
	);
}

/**
 * The way into a bot's computer desktop from the top of its chat, there at
 * any time. While the bot is using the desktop it says so in the bot's
 * colour, with a pulse, so people notice there's something to watch.
 */
export function ComputerButton({
	botName,
	inUse,
	onOpen,
}: {
	botName: string;
	/** Whether the bot is using the desktop right now. */
	inUse: boolean;
	onOpen: () => void;
}) {
	return inUse ? (
		<button
			type="button"
			onClick={onOpen}
			aria-label={`${botName} is using the computer. Open its desktop`}
			className="focus-ring flex h-8 shrink-0 items-center gap-2 rounded-md bg-bot-tint px-3 font-medium text-bot-text text-xs transition-colors max-md:h-11 max-md:rounded-full max-md:px-3.5"
		>
			<span aria-hidden className="relative flex size-2">
				<span className="absolute inline-flex size-full animate-ping rounded-full bg-bot-mono opacity-60 motion-reduce:animate-none" />
				<span className="relative inline-flex size-2 rounded-full bg-bot-mono" />
			</span>
			<span className="max-md:hidden">Computer in use</span>
			<Monitor aria-hidden size={17} strokeWidth={2} className="md:hidden" />
		</button>
	) : (
		<HeaderButton
			label="Computer"
			icon={<Monitor size={16} strokeWidth={1.75} />}
			onClick={onOpen}
		/>
	);
}
