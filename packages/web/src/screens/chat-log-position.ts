import {
	type RefObject,
	type UIEvent,
	useCallback,
	useEffect,
	useEffectEvent,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { keepFootInView, useFollowContentGrowth, useSettledAtLatest } from "@/lib/follow-latest.ts";

/**
 * How close to the foot of the log still counts as at the latest message, both
 * for following new messages and for marking the chat read: about two lines, so
 * a small nudge up is not taken as scrolling away.
 */
const LATEST_IN_VIEW_TOLERANCE_PX = 48;
/** How many older pages a jump to a message loads looking for it, before it gives up. */
const MAX_PAGES_TO_FIND = 10;
/** How long a message jumped to stays pointed out. */
const POINTED_OUT_MS = 2000;

/** The pages of a chat's messages, as far as positioning its log needs them. */
interface MessagePages {
	isSuccess: boolean;
	isPending: boolean;
	hasNextPage: boolean;
	isFetchingNextPage: boolean;
	data?: { pages: readonly unknown[] };
	fetchNextPage: () => Promise<unknown>;
}

/** Where a chat's log is scrolled to, and the ways to move it; see `useChatLogPosition`. */
export interface ChatLogPosition {
	/** For the log's `ref`: the element that scrolls. */
	attachViewport: (element: HTMLDivElement | null) => (() => void) | undefined;
	/** For the log's `onScroll`. */
	onScroll: (event: UIEvent<HTMLDivElement>) => void;
	/** Whether the log was last scrolled to its latest message. */
	latestInView: boolean;
	/** Whether the log has reached its latest since it opened; on a phone it is hidden until then. */
	settledAtLatest: boolean;
	/** Goes to the latest message, and follows new ones from there. */
	scrollToLatest: () => void;
	/** Loads the next older page, keeping the messages in view where they are. */
	loadOlder: () => Promise<void>;
	/** Jumps to the message `messageId`, as a reply's quote asks. */
	jumpTo: (messageId: string) => void;
	/** The message just jumped to, pointed out for a moment. */
	pointedOut: string | undefined;
	/** Whether the message asked for could not be found, after loading as many older pages as it may. */
	notFound: boolean;
}

/**
 * Keeps a chat's log at its latest message: opened there, and following each
 * new one while the viewer stays at the foot, until they scroll up or jump to
 * a message, the one the chat was opened at (`focusMessageId`) or one a quote
 * asks for.
 */
export function useChatLogPosition({
	messages,
	latestItemRevision,
	shownMessageIds,
	focusMessageId,
}: {
	messages: MessagePages;
	/** Changes whenever the newest item does; see `chatItemRevision`. */
	latestItemRevision: string;
	/** The messages loaded, to tell whether one jumped to is among them. */
	shownMessageIds: readonly string[];
	focusMessageId: string | undefined;
}): ChatLogPosition {
	const viewport = useRef<HTMLDivElement>(null);
	const positionedAtLatest = useRef(false);
	const followingLatest = useRef(true);
	const lastScrollTop = useRef(Number.NEGATIVE_INFINITY);
	// Where the log was last scrolled to. `followingLatest` is the intent to stay
	// at the latest message, which can be set before the scroll that gets there.
	const [latestInView, setLatestInView] = useState(true);

	useLayoutEffect(() => {
		if (
			latestItemRevision &&
			viewport.current &&
			(!positionedAtLatest.current || followingLatest.current)
		) {
			viewport.current.scrollTop = viewport.current.scrollHeight;
			positionedAtLatest.current = true;
		}
	}, [latestItemRevision]);

	async function loadOlder() {
		const element = viewport.current;
		const height = element?.scrollHeight ?? 0;
		const top = element?.scrollTop ?? 0;
		await messages.fetchNextPage();
		requestAnimationFrame(() => {
			if (element) element.scrollTop = top + element.scrollHeight - height;
		});
	}

	const [jumpTarget, jumpTo] = useJumpTarget(focusMessageId);
	const jump = useJumpToMessage({
		target: jumpTarget,
		shown: shownMessageIds.some((id) => id === jumpTarget?.messageId),
		viewport,
		older:
			!messages.isSuccess || messages.isFetchingNextPage
				? "loading"
				: messages.hasNextPage
					? "available"
					: "none",
		loadOlder,
		pagesLoaded: messages.data?.pages.length ?? 0,
		onJumped: () => {
			// Reading back from here: new messages no longer pull the chat to its foot.
			followingLatest.current = false;
			positionedAtLatest.current = true;
		},
	});

	useFollowContentGrowth(viewport, followingLatest);
	// Hidden on a phone until it is at the latest, rather than showing its top for a moment first.
	const settledAtLatest = useSettledAtLatest(viewport, followingLatest, !messages.isPending);
	const attachViewport = useCallback((element: HTMLDivElement | null) => {
		viewport.current = element;
		if (!element) return;
		const stopKeepingFoot = keepFootInView(element);
		return () => {
			stopKeepingFoot();
			viewport.current = null;
		};
	}, []);

	function onScroll(event: UIEvent<HTMLDivElement>) {
		const element = event.currentTarget;
		const atFoot =
			element.scrollHeight - element.scrollTop - element.clientHeight < LATEST_IN_VIEW_TOLERANCE_PX;
		if (atFoot) followingLatest.current = true;
		else if (element.scrollTop < lastScrollTop.current) followingLatest.current = false;
		lastScrollTop.current = element.scrollTop;
		setLatestInView(atFoot);
	}

	function scrollToLatest() {
		followingLatest.current = true;
		requestAnimationFrame(() => {
			if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
		});
	}

	return {
		attachViewport,
		onScroll,
		latestInView,
		settledAtLatest,
		scrollToLatest,
		loadOlder,
		jumpTo,
		pointedOut: jump.pointedOut,
		notFound: jump.notFound,
	};
}

/** One request to go to a message. Asking again for the same message is a new request. */
interface JumpTarget {
	messageId: string;
}

/**
 * The message to go to: the one the chat was opened at, until a reply's quote
 * asks for another, and again whenever the chat is opened at a new one.
 */
function useJumpTarget(
	focusMessageId: string | undefined,
): [JumpTarget | undefined, (messageId: string) => void] {
	const [target, setTarget] = useState(() => jumpTargetOf(focusMessageId));
	const [openedAt, setOpenedAt] = useState(focusMessageId);
	if (focusMessageId !== openedAt) {
		setOpenedAt(focusMessageId);
		setTarget(jumpTargetOf(focusMessageId));
	}
	return [target, (messageId) => setTarget({ messageId })];
}

function jumpTargetOf(messageId: string | undefined): JumpTarget | undefined {
	return messageId ? { messageId } : undefined;
}

/**
 * Jumps to the target's message once it is shown, loading older pages until it
 * is, up to a limit, then centres it, moves the focus to it, and points it out
 * for a moment. Each target is jumped to once. Returns the message pointed out,
 * if any, and whether the search gave up without finding it.
 */
function useJumpToMessage({
	target,
	shown,
	viewport,
	older,
	loadOlder,
	pagesLoaded,
	onJumped,
}: {
	target: JumpTarget | undefined;
	/** Whether the message is among those loaded. */
	shown: boolean;
	viewport: RefObject<HTMLDivElement | null>;
	/** Whether an older page can be loaded now, is on its way, or there is none. */
	older: "available" | "loading" | "none";
	loadOlder: () => Promise<void>;
	pagesLoaded: number;
	onJumped: () => void;
}): { pointedOut: string | undefined; notFound: boolean } {
	const jumped = useRef<JumpTarget>(undefined);
	const [pointedOut, setPointedOut] = useState<string>();
	const loadOlderPage = useEffectEvent(() => void loadOlder());
	const jumpedTo = useEffectEvent(onJumped);
	const searchedEnough = pagesLoaded >= MAX_PAGES_TO_FIND;
	useEffect(() => {
		if (!target || jumped.current === target) return;
		if (!shown) {
			if (older === "available" && !searchedEnough) loadOlderPage();
			return;
		}
		const row = [
			...(viewport.current?.querySelectorAll<HTMLElement>("[data-message-id]") ?? []),
		].find((candidate) => candidate.dataset.messageId === target.messageId);
		if (!row) return;
		jumped.current = target;
		// In the next frame, after the scroll event from the chat's first move to its
		// foot, which would otherwise say the chat is following its latest again.
		requestAnimationFrame(() => {
			if (viewport.current) centreIn(viewport.current, row);
			row.tabIndex = -1;
			row.focus({ preventScroll: true });
			jumpedTo();
		});
		setPointedOut(target.messageId);
	}, [target, shown, viewport, older, searchedEnough]);
	useEffect(() => {
		if (!pointedOut) return;
		const fade = setTimeout(() => setPointedOut(undefined), POINTED_OUT_MS);
		return () => clearTimeout(fade);
	}, [pointedOut]);
	const notFound =
		target !== undefined && !shown && older !== "loading" && (older === "none" || searchedEnough);
	return { pointedOut, notFound };
}

/**
 * Scrolls `scroller` alone so `row` sits in its middle. `scrollIntoView` would
 * also scroll every box around it, such as the app's frame, which is clipped
 * rather than meant to scroll, and leave the whole page shifted up.
 */
function centreIn(scroller: HTMLElement, row: HTMLElement) {
	const frame = scroller.getBoundingClientRect();
	const box = row.getBoundingClientRect();
	scroller.scrollTop += box.top - frame.top - (frame.height - box.height) / 2;
}
