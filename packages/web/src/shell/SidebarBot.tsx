import type { LivelyFace } from "@sugabots/avatars";
import type { Bot, NotificationSettings, ProjectMarker } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { useRef } from "react";
import { botLink } from "@/lib/links.ts";
import { countOf } from "@/lib/name-list.ts";
import { OWNER_MARK_SIZE_PX, ownerMarkTransition } from "@/lib/owner-mark.ts";
import { useOwnerProblems } from "@/lib/owner-pages.ts";
import { useHideSidebar } from "@/lib/sidebar-hidden.tsx";
import { MutedMark, NotificationsContextMenu } from "@/screens/NotificationLevelMenu.tsx";
import { TurnTakingAvatar } from "@/shell/Bot.tsx";
import { type Attention, AttentionDot, ProblemMark } from "@/ui/attention-dot.tsx";
import { sidebarRow } from "@/ui/sidebar-row.ts";

/** How a bot stands for the viewer, as the sidebar marks it: its default project's marker. */
export type BotStanding = ProjectMarker & { bot: Bot };

/**
 * A bot on one line, which opens its page: its threads on a phone, and
 * starting a thread with it on a wider screen. At its end, what is new in it,
 * and beside that an alert while something is wrong that its settings or
 * automations set right. Right-clicked, it offers its notifications.
 */
export function SidebarBot({
	standing,
	selected,
	notificationSettings,
}: {
	standing: BotStanding;
	/** Whether the bot's page is the one open. */
	selected: boolean;
	notificationSettings?: NotificationSettings;
}) {
	const { bot, unreadMessages, needsApproval, failedAutomations } = standing;
	const face = useRef<LivelyFace>(null);
	const hideSidebar = useHideSidebar();
	const problems = useOwnerProblems({ bot }, failedAutomations > 0);
	const problem = problems.settings ?? problems.automations;
	const attention = hasNews(standing);
	const notificationPlace = { kind: "bot", id: bot.id } as const;
	return (
		<li className="flex flex-col">
			<NotificationsContextMenu settings={notificationSettings} place={notificationPlace}>
				<Link
					{...botLink(bot)}
					aria-current={selected ? "page" : undefined}
					onDoubleClick={hideSidebar}
					onPointerEnter={() => face.current?.play("hop")}
					className={cn(sidebarRow({ selected, phone: true }), attention && "text-foreground")}
				>
					<span style={ownerMarkTransition(bot.id)} className="flex shrink-0">
						<TurnTakingAvatar bot={bot} size={OWNER_MARK_SIZE_PX} faceRef={face} />
					</span>
					<span className={cn("min-w-0 flex-1 truncate-fade", attention && "font-semibold")}>
						{bot.name}
					</span>
					<MutedMark settings={notificationSettings} place={notificationPlace} />
					{(attention || problem) && (
						<span className={cn(END_SLOT, problem && attention && "w-auto gap-1.5")}>
							{/* Read after its name, as a row reads what waits in it. */}
							<span className="sr-only">, </span>
							<RowAttention unreadMessages={unreadMessages} needsApproval={needsApproval} />
							{problem && <ProblemMark label={problem} />}
						</span>
					)}
				</Link>
			</NotificationsContextMenu>
		</li>
	);
}

/**
 * The end of a sidebar row, as wide as the + beside a section's name, so a
 * row's dot, its +, and the section's + all line up.
 */
const END_SLOT = "grid w-5.5 shrink-0 place-items-center";

/** What waits on the viewer in a bot or project. */
type Waiting = Pick<ProjectMarker, "unreadMessages" | "needsApproval">;

/** Whether a bot or project holds something the viewer has not seen: unread messages, or a decision. */
export function hasNews({ unreadMessages, needsApproval }: Waiting): boolean {
	return needsApproval || unreadMessages > 0;
}

/**
 * What a bot's or project's dot says, if anything: it needs the viewer, as a
 * decision or a mention does, or it holds unread messages, with how many.
 */
export function attentionOf({
	unreadMessages,
	needsApproval,
}: Waiting): { attention: Attention; label: string } | undefined {
	const unread =
		unreadMessages > 0 ? countOf(unreadMessages, "unread message", "unread messages") : undefined;
	if (needsApproval) {
		return { attention: "needsYou", label: unread ? `${unread}, needs you` : "Needs you" };
	}
	return unread ? { attention: "unread", label: unread } : undefined;
}

/**
 * At a row's end: a dot while it waits on the viewer. Unread messages show in
 * the row's bold name, so they are only counted for a screen reader.
 */
export function RowAttention({ className, ...waiting }: Waiting & { className?: string }) {
	const marker = attentionOf(waiting);
	if (!marker) return null;
	if (marker.attention === "unread") return <span className="sr-only">{marker.label}</span>;
	return <AttentionDot attention="needsYou" label={marker.label} className={className} />;
}
