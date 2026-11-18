import type { Channel, NotificationSettings } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { ChevronRight, Lock } from "lucide-react";
import type { ReactNode } from "react";
import { channelSettingsLink } from "@/lib/links.ts";
import { countOf } from "@/lib/name-list.ts";
import type { useBackToHere } from "@/lib/settings-back.tsx";
import { MutedMark, NotificationsContextMenu } from "@/screens/NotificationLevelMenu.tsx";
import { channelPalettes } from "@/shell/ChannelTile.tsx";
import { NESTED_INDENT } from "@/shell/ConversationList.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { SettingsIcon } from "@/ui/settings-icon.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";

/** A channel the viewer is in, with how its conversations stand for them. */
export interface ChannelStanding {
	channel: Channel;
	/** How many unread messages its conversations hold. */
	unreadMessages: number;
	/** Whether a conversation in it waits on the viewer. */
	needsApproval: boolean;
}

/** How a channel stands while the sidebar's markers have nothing for it, or have not loaded. */
export const NOTHING_NEW_IN_CHANNEL = { unreadMessages: 0, needsApproval: false };

/**
 * A channel in the sidebar: its name, which folds it away or opens it, and
 * under it, while open, `children`. Under the pointer or on focus, a caret
 * takes the place of the channel's mark, and `newThread` and its settings come
 * in at the end. Folded, it says how much is new in it, and is shaded while it
 * holds the page open. Right-clicked, it offers its notifications. A private
 * channel's name carries a lock.
 */
export function SidebarChannel({
	standing,
	open,
	holdsSelected,
	onToggle,
	settingsBack,
	notificationSettings,
	newThread,
	children,
}: {
	standing: ChannelStanding;
	open: boolean;
	/** Whether the page open is in this channel. */
	holdsSelected: boolean;
	onToggle: () => void;
	/** History state for the settings link, so its Back returns to the page it left. */
	settingsBack?: ReturnType<typeof useBackToHere>;
	/** What the viewer is notified about, once loaded. */
	notificationSettings?: NotificationSettings;
	/** What starts a thread in the channel. */
	newThread?: ReactNode;
	children: ReactNode;
}) {
	const { channel } = standing;
	const notificationPlace = { kind: "channel", id: channel.id } as const;
	const isPrivate = channel.visibility === "private";
	return (
		// biome-ignore lint/a11y/useSemanticElements: a channel's part of a sidebar holds links, not form controls, so a fieldset is wrong.
		<div role="group" aria-label={channel.name} className="flex flex-col">
			<NotificationsContextMenu settings={notificationSettings} place={notificationPlace}>
				<div
					className={cn(
						"group/channel flex h-8 items-center rounded-sm pr-1.5 transition-colors",
						!open && holdsSelected ? "bg-row-selected" : "hover:bg-row-hover",
					)}
				>
					<button
						type="button"
						aria-expanded={open}
						onClick={onToggle}
						className="focus-ring flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-sm pl-2 text-left"
					>
						<span className="grid size-5 shrink-0 place-items-center *:col-start-1 *:row-start-1">
							<ChannelInitial
								channel={channel}
								className="group-hover/channel:invisible group-has-focus-visible/channel:invisible"
							/>
							<ChevronRight
								aria-hidden
								size={14}
								strokeWidth={2.25}
								className={cn(
									"invisible text-muted-foreground transition-transform group-hover/channel:visible group-has-focus-visible/channel:visible",
									open && "rotate-90",
								)}
							/>
						</span>
						<span className="flex min-w-0 flex-1 items-center gap-1.5">
							<span
								className={cn(
									"min-w-0 truncate text-sm",
									// Grey like the rows under it; bright when folded over something new.
									!open && hasNews(standing)
										? "font-semibold text-foreground"
										: "font-medium text-muted-foreground group-hover/channel:text-foreground",
								)}
							>
								{channel.name}
							</span>
							{isPrivate && (
								<Lock
									aria-label="Private"
									size={11}
									strokeWidth={2.25}
									className="shrink-0 text-subtle-foreground"
								/>
							)}
						</span>
						<MutedMark settings={notificationSettings} place={notificationPlace} />
					</button>
					{!open && <ChannelNews standing={standing} />}
					<span className="hidden group-hover/channel:contents group-has-focus-visible/channel:contents">
						{newThread}
					</span>
					<IconButton
						label={`${channel.name} settings`}
						size="sm"
						render={<Link {...channelSettingsLink(channel)} state={settingsBack} />}
						className="hidden group-hover/channel:grid group-has-focus-visible/channel:grid"
					>
						<SettingsIcon />
					</IconButton>
				</div>
			</NotificationsContextMenu>
			{open && <div className={cn("flex flex-col", NESTED_INDENT)}>{children}</div>}
		</div>
	);
}

function hasNews({ unreadMessages, needsApproval }: ChannelStanding): boolean {
	return needsApproval || unreadMessages > 0;
}

/**
 * What is new in a folded channel: a dot while something waits on the viewer's
 * approval. Anything else shows in the channel's bold name, so it is only counted
 * for a screen reader.
 */
function ChannelNews({ standing }: { standing: ChannelStanding }) {
	const { unreadMessages, needsApproval } = standing;
	if (needsApproval) {
		return (
			<Tooltip label="Waiting for your approval" side="right">
				<span className="mr-2 size-1.5 shrink-0 rounded-full bg-foreground">
					<span className="sr-only">Waiting for your approval</span>
				</span>
			</Tooltip>
		);
	}
	if (unreadMessages === 0) return null;
	return (
		<span className="sr-only">{countOf(unreadMessages, "unread message", "unread messages")}</span>
	);
}

type ChannelMarkSource = Pick<Channel, "name" | "color">;

type ChannelInitialSize = "lg" | "md" | "sm";

/** A channel as a small square holding its initial, in the channel's colour. */
export function ChannelInitial({
	channel,
	size = "md",
	className,
}: {
	/** Only what it is drawn from, so a channel not made yet, such as New channel's, can be drawn too. */
	channel: ChannelMarkSource;
	/**
	 * `sm` is a quieter mark for a row that names its channel: the letter in the
	 * channel's colour on a tint of it. `lg` stands beside the title of the
	 * channel's own settings.
	 */
	size?: ChannelInitialSize;
	className?: string;
}) {
	const palette = channel.color === null ? undefined : channelPalettes[channel.color];
	const small = size === "sm";
	return (
		<span
			aria-hidden
			className={cn(
				"grid shrink-0 place-items-center font-semibold",
				{
					sm: "size-4 rounded text-3xs",
					md: "size-5 rounded-xs text-2xs",
					lg: "size-11 rounded-xl text-sm",
				}[size],
				!palette && "bg-tile text-foreground",
				palette && !small && "text-black/80",
				className,
			)}
			style={
				palette &&
				(small
					? { background: palette.tile, color: palette.swatch }
					: { background: palette.swatch })
			}
		>
			{Array.from(channel.name.trim())[0]?.toUpperCase() ?? ""}
		</span>
	);
}
