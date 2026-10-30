import type { NotificationLevel, NotificationSettings } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import {
	AtSign,
	Bell,
	BellOff,
	BellRing,
	ChevronDown,
	Clock,
	Ellipsis,
	type LucideIcon,
	Settings,
} from "lucide-react";
import type { ReactElement } from "react";
import {
	formatUntil,
	levelAbove,
	levelChosenFor,
	MUTE_DURATIONS,
	mutedUntilFor,
	NOTIFICATION_LEVEL_LABELS,
	type NotificationPlace,
	useMuteNotifications,
	useSetNotificationLevel,
} from "@/lib/notifications.ts";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuTrigger,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroupLabel,
	DropdownMenuItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";

/**
 * Right-clicking `children`, a pod's or a bot's row in the sidebar, offers
 * what it notifies the person about, muting it among them, and, under More
 * options, muting it for a while, as Slack's channel menu does. Until
 * `settings` load, right-clicking does nothing; `children` stays the same
 * element either way, so the row isn't remounted when they arrive.
 */
export function NotificationsContextMenu({
	settings,
	place,
	children,
}: {
	settings: NotificationSettings | undefined;
	place: NotificationPlace;
	children: ReactElement;
}) {
	return (
		<ContextMenu disabled={!settings}>
			<ContextMenuTrigger render={children} />
			{settings && (
				<ContextMenuContent className="min-w-60">
					<LevelChoices settings={settings} place={place} label="Notify you about…" />
					<DropdownMenuSeparator />
					<MoreOptions settings={settings} place={place} />
				</ContextMenuContent>
			)}
		</ContextMenu>
	);
}

/**
 * Slack's More options: muting the place for one of its durations or, while
 * it is muted for a while, unmuting it, then the way to every notification
 * setting. A place that notifies of nothing anyway has no durations to offer.
 */
function MoreOptions({
	settings,
	place,
}: {
	settings: NotificationSettings;
	place: NotificationPlace;
}) {
	const mute = useMuteNotifications();
	const mutedUntil = mutedUntilFor(settings, place);
	const notifiesOfNothing =
		(levelChosenFor(settings, place) ?? levelAbove(settings, place)) === "nothing";
	return (
		<DropdownMenuSub>
			<DropdownMenuSubTrigger>
				<Ellipsis />
				More options
			</DropdownMenuSubTrigger>
			<DropdownMenuContent side="right" align="start" className="min-w-52">
				{mutedUntil ? (
					<DropdownMenuItem onClick={() => mute.mutate({ place, until: null })}>
						<Bell />
						<span className="flex flex-col">
							Unmute
							<span className="text-[13px] text-muted-foreground">
								Muted until {formatUntil(mutedUntil)}
							</span>
						</span>
					</DropdownMenuItem>
				) : (
					!notifiesOfNothing &&
					MUTE_DURATIONS.map((duration) => (
						<DropdownMenuItem
							key={duration.label}
							onClick={() => mute.mutate({ place, until: duration.until(new Date()) })}
						>
							<Clock />
							Mute {duration.label.toLowerCase()}
						</DropdownMenuItem>
					))
				)}
				{(mutedUntil || !notifiesOfNothing) && <DropdownMenuSeparator />}
				<DropdownMenuItem
					render={
						<Link
							from="/$workspace"
							to="./settings/$section"
							params={{ section: "notifications" }}
						/>
					}
				>
					<Settings />
					Notification settings
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenuSub>
	);
}

/** A bell struck through, after the name of a pod or bot the person muted, for good or for a while. */
export function MutedMark({
	settings,
	place,
}: {
	settings: NotificationSettings | undefined;
	place: NotificationPlace;
}) {
	if (!settings) return null;
	const mutedUntil = mutedUntilFor(settings, place);
	if (!mutedUntil && levelChosenFor(settings, place) !== "nothing") return null;
	return (
		<BellOff
			role="img"
			aria-label={mutedUntil ? `Muted until ${formatUntil(mutedUntil)}` : "Muted"}
			size={13}
			strokeWidth={1.75}
			className="shrink-0 text-subtle-foreground"
		/>
	);
}

/** The level chosen for a place, in a settings row, and the menu that changes it. */
export function NotificationLevelPicker({
	settings,
	place,
	name,
}: {
	settings: NotificationSettings;
	place: NotificationPlace;
	name: string;
}) {
	const chosen = levelChosenFor(settings, place);
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label={`Notifications for ${name}`}
				className="focus-ring flex shrink-0 items-center gap-1 rounded-md text-[14px] text-muted-foreground transition-colors hover:text-foreground"
			>
				{chosen ? NOTIFICATION_LEVEL_LABELS[chosen] : "Default"}
				<ChevronDown aria-hidden size={14} strokeWidth={2} />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-56">
				<LevelChoices settings={settings} place={place} />
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** The choice that follows the level above, as against choosing one for this place. */
const FOLLOW = "follow";

const LEVEL_ICONS: Record<NotificationLevel, LucideIcon> = {
	all: BellRing,
	mentions: AtSign,
	nothing: BellOff,
};

const LEVELS = Object.keys(LEVEL_ICONS) as NotificationLevel[];

/** The levels a place can take, the one it follows from above first, under `label` when given. */
function LevelChoices({
	settings,
	place,
	label,
}: {
	settings: NotificationSettings;
	place: NotificationPlace;
	label?: string;
}) {
	const setLevel = useSetNotificationLevel();
	const followed = levelAbove(settings, place);
	const FollowedIcon = LEVEL_ICONS[followed];
	return (
		<DropdownMenuRadioGroup
			value={levelChosenFor(settings, place) ?? FOLLOW}
			onValueChange={(value: string) =>
				setLevel.mutate({ place, level: value === FOLLOW ? null : (value as NotificationLevel) })
			}
		>
			{label && <DropdownMenuGroupLabel>{label}</DropdownMenuGroupLabel>}
			<DropdownMenuRadioItem value={FOLLOW} closeOnClick>
				<FollowedIcon className="text-muted-foreground" />
				Default ({NOTIFICATION_LEVEL_LABELS[followed].toLowerCase()})
			</DropdownMenuRadioItem>
			{LEVELS.map((level) => {
				const Icon = LEVEL_ICONS[level];
				return (
					<DropdownMenuRadioItem key={level} value={level} closeOnClick>
						<Icon />
						{NOTIFICATION_LEVEL_LABELS[level]}
					</DropdownMenuRadioItem>
				);
			})}
		</DropdownMenuRadioGroup>
	);
}
