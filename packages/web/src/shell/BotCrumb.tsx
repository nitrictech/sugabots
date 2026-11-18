import type { Bot } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { automationsLink, botLink } from "@/lib/links.ts";
import { BotAvatar } from "@/shell/Bot.tsx";

/**
 * A bot at the head of a page's breadcrumb, as "Growth Desk / Files" has
 * it: its face and name, leading to its own page.
 */
export function BotCrumb({ bot }: { bot: Bot }) {
	return (
		<Link
			{...botLink(bot)}
			className="focus-ring flex min-w-0 shrink items-center gap-1.5 rounded-sm font-medium text-muted-foreground text-sm transition-colors hover:text-foreground"
		>
			<span aria-hidden className="flex shrink-0">
				<BotAvatar color={bot.color} face={bot.face} shape={bot.shape} size={16} />
			</span>
			<span className="min-w-0 truncate">{bot.name}</span>
		</Link>
	);
}

/** Between a breadcrumb's steps. */
export function CrumbSeparator() {
	return (
		<span aria-hidden className="shrink-0 text-subtle-foreground text-sm">
			/
		</span>
	);
}

/** The head of an automation's breadcrumb: its bot, then the bot's Automations, which leads back to them. */
export function AutomationsCrumb({ bot }: { bot: Bot }) {
	return (
		<>
			<BotCrumb bot={bot} />
			<CrumbSeparator />
			<Link
				{...automationsLink(bot)}
				className="focus-ring shrink-0 rounded-sm font-medium text-muted-foreground text-sm transition-colors hover:text-foreground"
			>
				Automations
			</Link>
		</>
	);
}
