import { cn } from "cn";
import { countOf } from "@/lib/name-list.ts";
import { AttentionDot } from "@/ui/attention-dot.tsx";
import { COUNT_BADGE_SIZES, CountBadge, type CountBadgeSize } from "@/ui/count-badge.tsx";

/**
 * What is new in Inbox, where a place leads to it: how many unread messages
 * mention the viewer, or a dot while only other things are unread. Only what needs the viewer is
 * counted, as the app's badge counts it.
 */
export function InboxNews({
	unreadForYou,
	unreadInInbox,
	size,
	countClassName,
}: {
	unreadForYou: number;
	unreadInInbox: number;
	/** The count's size, whose box the dot is centred in. */
	size: CountBadgeSize;
	/** Merged over the count's own; the dot keeps its own. */
	countClassName?: string;
}) {
	if (unreadForYou > 0) {
		return (
			<CountBadge
				count={unreadForYou}
				size={size}
				label={countOf(unreadForYou, "unread message for you", "unread messages for you")}
				className={countClassName}
			/>
		);
	}
	if (unreadInInbox === 0) return null;
	return (
		<span className={cn("grid shrink-0 place-items-center", COUNT_BADGE_SIZES[size])}>
			<AttentionDot attention="unread" />
			<span className="sr-only">{countOf(unreadInInbox, "unread item", "unread items")}</span>
		</span>
	);
}
