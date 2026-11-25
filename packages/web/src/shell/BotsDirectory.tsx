import type { Bot } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { Pin, PinOff, Plus } from "lucide-react";
import { useBots, usePinBot } from "@/lib/bots.ts";
import { failureMessage } from "@/lib/failure.ts";
import { botLink, botSettingsLink } from "@/lib/links.ts";
import { BotAvatar } from "@/shell/Bot.tsx";
import { useNewBot } from "@/shell/NewBot.tsx";
import { Page } from "@/shell/Page.tsx";
import { Alert } from "@/ui/alert.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { SettingsGroup, SettingsRow, SettingsValue } from "@/ui/settings-page.tsx";

/**
 * Every bot the member reaches: their Personal Assistant, the public bots
 * and their own personal ones, each opening the bot, with a pin that puts it
 * in the sidebar or takes it out. A + makes another.
 */
export function BotsDirectory() {
	const { bots: reachable, isPending, error } = useBots();
	const pin = usePinBot();
	const newBot = useNewBot();
	const bots = reachable ?? [];
	const assistant = bots.filter((bot) => bot.assistant);
	const rest = bots.filter((bot) => !bot.assistant);
	return (
		<Page
			title="Bots"
			place={{ kind: "tab" }}
			actions={
				newBot.start && (
					<IconButton label="New bot" variant="bar" onClick={newBot.start}>
						<Plus size={16} strokeWidth={1.75} />
					</IconButton>
				)
			}
		>
			<div className="mx-auto flex w-full max-w-180 flex-col gap-6 px-4 pt-6 pb-12">
				{error ? <Alert>{failureMessage(error)}</Alert> : null}
				{pin.error ? <Alert>{failureMessage(pin.error)}</Alert> : null}
				{assistant.length > 0 && (
					<SettingsGroup label="Yours" headingLevel={2}>
						{assistant.map((bot) => (
							<BotRow key={bot.id} bot={bot} />
						))}
					</SettingsGroup>
				)}
				{!isPending && rest.length === 0 ? (
					<EmptyState title="No bots yet">
						{newBot.start ? "Make the first one with the + above." : "Nobody has made one yet."}
					</EmptyState>
				) : (
					rest.length > 0 && (
						<SettingsGroup label="In this workspace" headingLevel={2}>
							{rest.map((bot) => (
								<BotRow
									key={bot.id}
									bot={bot}
									onPin={(pinned) => pin.mutate({ botId: bot.id, pinned })}
									pinning={pin.isPending && pin.variables?.botId === bot.id}
								/>
							))}
						</SettingsGroup>
					)
				)}
			</div>
			{newBot.dialog}
		</Page>
	);
}

/**
 * A bot in the directory: its face, name and what it's for, with its pin.
 * The name opens the bot, or, for someone else's personal bot an
 * administrator only sees listed, its settings; the pin sits beside it, so no
 * button is inside a link.
 */
function BotRow({
	bot,
	onPin,
	pinning = false,
}: {
	bot: Bot;
	/** Pins or unpins it; absent for the Personal Assistant, which is always at the sidebar's top. */
	onPin?: (pinned: boolean) => void;
	pinning?: boolean;
}) {
	const usable = bot.permissions.talk;
	const nameClassName = "focus-ring rounded-sm hover:underline";
	return (
		<SettingsRow
			icon={<BotAvatar color={bot.color} eyes={bot.eyes} shape={bot.shape} size={24} />}
			label={
				usable ? (
					<Link {...botLink(bot)} className={nameClassName}>
						{bot.name}
					</Link>
				) : bot.permissions.resources.openSettings ? (
					<Link {...botSettingsLink(bot)} className={nameClassName}>
						{bot.name}
					</Link>
				) : (
					bot.name
				)
			}
			sub={
				bot.assistant
					? "Your Personal Assistant"
					: [
							bot.visibility === "personal"
								? usable
									? "Personal"
									: "Someone else's personal bot"
								: null,
							bot.description,
						]
							.filter(Boolean)
							.join(" · ") || undefined
			}
			trailing={
				!usable ? null : onPin ? (
					<IconButton
						label={bot.pinned ? `Unpin ${bot.name}` : `Pin ${bot.name}`}
						size="sm"
						disabled={pinning}
						onClick={() => onPin(!bot.pinned)}
					>
						{bot.pinned ? <PinOff strokeWidth={2} /> : <Pin strokeWidth={2} />}
					</IconButton>
				) : (
					<SettingsValue>Always pinned</SettingsValue>
				)
			}
		/>
	);
}
