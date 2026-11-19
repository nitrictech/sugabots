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

/** The bots that can lead a project: the workspace's public bots, which alone are in projects. */
function useLeadableBots(): readonly Bot[] {
	const { bots } = useBots();
	return bots?.filter((bot) => bot.visibility === "public" && !bot.assistant) ?? [];
}

/**
 * Choosing a project's lead bot, which answers its threads unless people
 * mention another: one of the workspace's public bots, added to the project
 * if it isn't in it yet.
 */
export function LeadBotPicker({
	value,
	onChange,
	disabled = false,
}: {
	/** The lead bot's id; null while none is chosen. */
	value: string | null;
	onChange: (botId: string) => void;
	disabled?: boolean;
}) {
	const leadable = useLeadableBots();
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
							<BotAvatar color={lead.color} face={lead.face} shape={lead.shape} size={20} />
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
					<DropdownMenuItem disabled>No public bots yet.</DropdownMenuItem>
				) : (
					leadable.map((bot) => (
						<DropdownMenuItem key={bot.id} onClick={() => onChange(bot.id)}>
							<span aria-hidden>
								<BotAvatar color={bot.color} face={bot.face} shape={bot.shape} size={22} />
							</span>
							<span className="min-w-0 flex-1 truncate">{bot.name}</span>
						</DropdownMenuItem>
					))
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
