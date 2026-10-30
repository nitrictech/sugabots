import type { useRender } from "@base-ui/react/use-render";
import { useCanGoBack, useRouter } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { cloneElement, isValidElement, type MouseEvent, type ReactElement } from "react";
import { pageBehind, type TrailPage } from "@/lib/history-trail.ts";
import { SIDE_BY_SIDE, useMediaQuery } from "@/lib/media.ts";

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
 * Leaving a page as a phone's own Back leaves it, which every Back and every
 * way out of a page goes through. `home` is where the page lives, and
 * `toHome` goes there in this page's place, so home's own Back never returns
 * here.
 *
 * - `leave(toHome)` goes back to the page this one was opened from, which
 *   could be anywhere, as Back does, so a thread opened from Home goes back to
 *   Home; or `toHome` when this page was the first one opened.
 * - `leaveFor(isHome, toHome)` goes back only when the page behind is home,
 *   as `isHome` tells it, and otherwise `toHome`: for a page that is gone,
 *   whose Back would otherwise return to it, or a thread that must close onto
 *   its own chat rather than whatever was open before it.
 * - `label(home)` names where `leave` goes: plainly "Back" to the opener, or
 *   "Back to" `home`.
 */
export function useLeave() {
	const router = useRouter();
	const opened = useCanGoBack();
	const leave = (toHome: () => void) => {
		if (router.history.canGoBack()) router.history.back();
		else toHome();
	};
	const leaveFor = (isHome: (page: TrailPage) => boolean, toHome: () => void) => {
		const behind = pageBehind(router.history, router.state.location);
		if (behind && isHome(behind)) router.history.back();
		else toHome();
	};
	/** `leaveFor` the page at `href`, such as the list a deleted thing was in. */
	const leaveForPage = (href: string) => {
		const { pathname } = new URL(href, window.location.origin);
		leaveFor(
			(page) => page.pathname === pathname,
			() => void router.navigate({ href, replace: true }),
		);
	};
	return {
		label: (home: string) => (opened ? "Back" : `Back to ${home}`),
		leave,
		leaveFor,
		leaveForPage,
	};
}

/**
 * Whether `event` is a plain click, to follow in this tab: a modified or
 * middle click on a Back link is left to the browser, which opens the link's
 * page in a new tab.
 */
export function isPlainClick(event: MouseEvent): boolean {
	return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/**
 * A Back link, `link`, as a phone's Back: it leaves as `useLeave` does, to
 * the page this one was opened from, or the link's page in this one's place,
 * and says plainly "Back" when it could land anywhere. On a wider screen the
 * link is as given, as is a Back that goes nowhere, such as a button going
 * back within its page.
 */
export function usePhoneBack<Link extends useRender.RenderProp>(link: Link): Link {
	const { leave, label } = useLeave();
	const phone = !useMediaQuery(SIDE_BY_SIDE);
	if (!phone || !isValidElement<{ to?: string; "aria-label"?: string }>(link)) return link;
	if (link.props.to === undefined) return link;
	const named = link.props["aria-label"];
	const asPhoneBack: Record<string, unknown> = {
		replace: true,
		// Before the link's own click, which goes on to the link's page when this one was opened first.
		onClickCapture: (event: MouseEvent) => {
			if (!isPlainClick(event)) return;
			let toLinksPage = false;
			leave(() => {
				toLinksPage = true;
			});
			if (!toLinksPage) event.preventDefault();
		},
	};
	if (named?.startsWith(BACK_TO)) asPhoneBack["aria-label"] = label(named.slice(BACK_TO.length));
	return cloneElement(link as ReactElement<Record<string, unknown>>, asPhoneBack) as Link;
}

/** How a Back link's name begins when it names the page it goes to. */
const BACK_TO = "Back to ";
