import { BellRing } from "lucide-react";
import { useState } from "react";
import { useBrowserNotifications } from "@/lib/notifications.ts";
import { Button } from "@/ui/button.tsx";
import { CloseButton } from "@/ui/close-button.tsx";

const DISMISSED_KEY = "sugabots-notifications-prompt-dismissed";

/**
 * A bar across the top of the app asking, until answered, to turn
 * notifications on in this browser, as Slack's does. Browsers only ask
 * permission after a click, and they hold it against a site that asks before
 * it is wanted, so this asks first in the app's own words.
 */
export function NotificationsPrompt() {
	const { status, enable } = useBrowserNotifications();
	const [dismissed, setDismissed] = useState(readDismissed);
	if (dismissed || status.state !== "off") return null;

	function dismiss() {
		setDismissed(true);
		try {
			localStorage.setItem(DISMISSED_KEY, "1");
		} catch {
			// Storage can be off. The prompt stays away until the page reloads.
		}
	}

	return (
		<section
			aria-label="Turn on notifications"
			className="flex shrink-0 items-center gap-3 border-border border-b bg-panel py-1.5 pr-2 pl-4"
		>
			<BellRing aria-hidden size={16} className="shrink-0 text-link" />
			<p className="m-0 min-w-0 flex-1 text-[13.5px] text-soft-foreground leading-normal">
				Get notified when you're mentioned, a bot replies to you, or one needs your approval.
			</p>
			<Button size="sm" disabled={enable.isPending} onClick={() => enable.mutate()}>
				Turn on
			</Button>
			<CloseButton label="Not now" onClick={dismiss} />
		</section>
	);
}

function readDismissed(): boolean {
	try {
		return localStorage.getItem(DISMISSED_KEY) !== null;
	} catch {
		return false;
	}
}
