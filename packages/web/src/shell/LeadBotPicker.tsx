import type { Bot } from "@sugabots/contracts";
import { ChevronDown } from "lucide-react";
import { useBots } from "@/lib/bots.ts";
import { BotAvatar } from "@/shell/Bot.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";

/**
 * Whether `bot` may be in a project that is `private` or not: a public bot in
 * any, a private bot only in a private one, and a personal bot in none.
 */
export function canBeInProject(bot: Bot, project: { readonly private: boolean }): boolean {
	if (bot.assistant) return false;
	return bot.visibility === "public" || (bot.visibility === "private" && project.private);
}

/**
 * Choosing a project's lead bot, which answers its chats unless members
 * mention another: one of the bots you can talk to that may be in the project,
 * added to it if it isn't in it yet.
 */
export function LeadBotPicker({
	value,
	onChange,
	privateProject,
	disabled = false,
}: {
	/** The lead bot's id; null while none is chosen. */
	value: string | null;
	onChange: (botId: string) => void;
	/** Whether the project is private, so a private bot may lead it. */
	privateProject: boolean;
	disabled?: boolean;
}) {
	const { bots } = useBots();
	const leadable = bots?.filter((bot) => canBeInProject(bot, { private: privateProject })) ?? [];
	const lead = leadable.find((bot) => bot.id === value);
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				disabled={disabled}
				aria-label={lead ? `Lead bot: ${lead.name}` : "Choose a lead bot"}
				className="focus-ring flex h-8 min-w-0 max-w-60 items-center gap-2 rounded-lg border border-border px-2 text-left text-sm transition-colors hover:bg-row-hover disabled:opacity-60"
			>
				{lead ? (
					<>
						<span aria-hidden>
							<BotAvatar color={lead.color} eyes={lead.eyes} shape={lead.shape} size={20} />
						</span>
						<span className="min-w-0 flex-1 truncate">{lead.name}</span>
					</>
				) : (
					<span className="min-w-0 flex-1 truncate text-muted-foreground">Choose a bot</span>
				)}
				<ChevronDown size={14} aria-hidden className="shrink-0 text-muted-foreground" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-52">
				{leadable.length === 0 ? (
					<DropdownMenuItem disabled>No bots can lead it yet.</DropdownMenuItem>
				) : (
					leadable.map((bot) => (
						<BotMenuItem key={bot.id} bot={bot} onClick={() => onChange(bot.id)} />
					))
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** A bot in a menu of bots to pick from: its face, then its name. */
export function BotMenuItem({ bot, onClick }: { bot: Bot; onClick: () => void }) {
	return (
		<DropdownMenuItem onClick={onClick}>
			<span aria-hidden>
				<BotAvatar color={bot.color} eyes={bot.eyes} shape={bot.shape} size={22} />
			</span>
			<span className="min-w-0 flex-1 truncate">{bot.name}</span>
		</DropdownMenuItem>
	);
}
