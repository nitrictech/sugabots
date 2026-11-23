import type { Bot } from "@sugabots/contracts";
import { cn } from "cn";
import { Monitor } from "lucide-react";
import { useComputerGap } from "@/lib/computer-providers.ts";
import { useDesktopInUse } from "@/lib/desktop.ts";
import { FLOATING_ON_PHONE, IconButton } from "@/ui/icon-button.tsx";
import { LiveDot } from "@/ui/live-dot.tsx";

/**
 * The container a chat's header is, which `ChatComputer` measures to know
 * whether its name fits beside its icon.
 */
export const CHAT_HEADER_CONTAINER = "@container/chat-header";

/**
 * The way into the bot's computer desktop from the top of its chat, there
 * at any time, so it opens to say how to get one when the workspace or the
 * bot has none. While the bot is using the desktop it says so in the bot's
 * colour, with a pulse, so people notice there's something to watch.
 * Otherwise it is its icon, with its name beside it while the header is wide
 * enough; on a phone, only the icon, round on glass.
 */
export function ChatComputer({
	bot,
	chatId,
	onOpen,
}: {
	bot: Bot;
	/** The chat the bot's desktop is watched from. */
	chatId: string;
	onOpen: () => void;
}) {
	const hasComputer = useComputerGap({ bot }) === null;
	const inUse = useDesktopInUse(chatId, bot.id);
	if (hasComputer && inUse) {
		return (
			<button
				type="button"
				onClick={onOpen}
				aria-label={`${bot.name} is using the computer. Open its desktop`}
				className="focus-ring flex h-8 shrink-0 items-center gap-2 rounded-md bg-bot-tint px-3 font-medium text-bot-text text-xs transition-colors max-md:h-11 max-md:rounded-full max-md:px-3.5"
			>
				<LiveDot />
				<span className="max-md:hidden">Computer in use</span>
				<Monitor aria-hidden size={17} strokeWidth={2} className="md:hidden" />
			</button>
		);
	}
	return (
		<IconButton
			label="Computer"
			variant="bar"
			onClick={onOpen}
			className={cn(
				"text-muted-foreground hover:text-foreground md:@2xl/chat-header:flex md:@2xl/chat-header:w-auto md:@2xl/chat-header:gap-1.5 md:@2xl/chat-header:px-2.5",
				FLOATING_ON_PHONE,
			)}
		>
			<Monitor size={16} strokeWidth={1.75} />
			<span className="hidden font-medium text-xs md:@2xl/chat-header:inline">Computer</span>
		</IconButton>
	);
}
