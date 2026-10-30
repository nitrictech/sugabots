import { useCanGoBack, useRouter } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";

/*
 * A phone's one Back: a round glass button at the top left of every page,
 * 44px as a phone's own are. A Back that is a text link on a wider screen,
 * as settings' are, becomes this on a phone with `BACK_ON_PHONE`, its label
 * kept for a screen reader in `BACK_LABEL_ON_PHONE`.
 */

/** The round Back's look, for the link or button that is one. */
export const BACK_BUTTON =
	"focus-ring glass flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-full text-foreground transition-colors active:bg-hover-strong";

/** Merged over a text Back link, so a phone draws it as the round Back. */
export const BACK_ON_PHONE =
	"max-md:glass max-md:size-11 max-md:justify-center max-md:rounded-full max-md:text-foreground max-md:active:bg-hover-strong";

/** On a Back link's label, so a phone shows only the chevron and a screen reader still hears where it goes. */
export const BACK_LABEL_ON_PHONE = "max-md:sr-only";

/** The round Back's chevron. */
export function BackChevron({ className }: { className?: string }) {
	return <ChevronLeft aria-hidden size={22} strokeWidth={2.25} className={className} />;
}

/**
 * Back to the page this one was opened from, as a phone's own back does, so a
 * thread opened from Home goes back to Home. `goBack` returns false, having
 * done nothing, when this page was the first one opened, for the caller to go
 * to where the page lives instead. `label` names the way Back goes: plainly
 * "Back" to the opener, which could be anywhere, or "Back to" `home`.
 */
export function useReturnToOpener() {
	const history = useRouter().history;
	const opened = useCanGoBack();
	return {
		goBack(): boolean {
			if (!history.canGoBack()) return false;
			history.back();
			return true;
		},
		label: (home: string) => (opened ? "Back" : `Back to ${home}`),
	};
}
