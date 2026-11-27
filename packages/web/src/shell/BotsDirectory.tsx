import type { Bot } from "@sugabots/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { Pin, PinOff, Plus } from "lucide-react";
import {
	isOwnAssistant,
	ownAssistants,
	useBots,
	useCreateAssistant,
	usePinBot,
	whoseBot,
} from "@/lib/bots.ts";
import { failureMessage } from "@/lib/failure.ts";
import { botLink, botSettingsLink } from "@/lib/links.ts";
import { BotAvatar } from "@/shell/Bot.tsx";
import { useNewBot } from "@/shell/NewBot.tsx";
import { DirectoryBody, Page } from "@/shell/Page.tsx";
import { Alert } from "@/ui/alert.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { SettingsGroup, SettingsRow, SettingsValue } from "@/ui/settings-page.tsx";

/**
 * Every bot the member reaches: their Personal Assistants, oldest first, if
 * they have any, with a + that makes them one, then the public bots, the
 * private ones they are a member of and their own personal ones, each opening
 * the bot, with a pin that puts it in the sidebar or takes it out. A + makes
 * another bot.
 */
export function BotsDirectory() {
	const { bots: reachable, isPending, error } = useBots();
	const pin = usePinBot();
	const newBot = useNewBot();
	const newAssistant = useNewAssistant();
	const bots = reachable ?? [];
	const assistants = ownAssistants(bots);
	const rest = bots.filter((bot) => !isOwnAssistant(bot));
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
			<DirectoryBody>
				{error ? <Alert>{failureMessage(error)}</Alert> : null}
				{pin.error ? <Alert>{failureMessage(pin.error)}</Alert> : null}
				{newAssistant.error ? <Alert>{failureMessage(newAssistant.error)}</Alert> : null}
				{!isPending && !error && (
					<SettingsGroup
						label="Yours"
						headingLevel={2}
						action={
							<IconButton
								label="New Personal Assistant"
								size="sm"
								className="max-md:size-11"
								disabled={newAssistant.isPending}
								onClick={newAssistant.start}
							>
								<Plus strokeWidth={2.2} />
							</IconButton>
						}
					>
						{assistants.length === 0 ? (
							<SettingsRow label="You have no Personal Assistant" />
						) : (
							assistants.map((bot) => <BotRow key={bot.id} bot={bot} />)
						)}
					</SettingsGroup>
				)}
				{!isPending && !error && rest.length === 0 ? (
					<EmptyState title={assistants.length > 0 ? "No other bots yet" : "No bots yet"}>
						{newBot.start && "Use New bot to make one."}
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
			</DirectoryBody>
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
	/** Pins or unpins it; absent for a Personal Assistant, which is always at the sidebar's top. */
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
					? usable
						? "Your Personal Assistant"
						: whoseBot(bot, "Personal Assistant")
					: [
							bot.visibility === "personal"
								? usable
									? "Personal"
									: whoseBot(bot, "personal bot")
								: bot.visibility === "private"
									? "Private"
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

/** Making the member a Personal Assistant, whatever their role, then opening it. */
function useNewAssistant() {
	const create = useCreateAssistant();
	const navigate = useNavigate();
	return {
		start: () => create.mutate(undefined, { onSuccess: (made) => void navigate(botLink(made)) }),
		isPending: create.isPending,
		error: create.error,
	};
}
