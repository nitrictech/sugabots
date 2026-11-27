import type { ChatMessageItem } from "@sugabots/contracts";
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
import {
	keepFootInView,
	loadOlderKeepingPlace,
	useFollowContentGrowth,
	useSettledAtLatest,
} from "@/lib/follow-latest.ts";
import { messagesIn } from "./chat-items.ts";

/**
 * How close to the foot of the log still counts as at the latest message, both
 * for following new messages and for marking the chat read: about two lines, so
 * a small nudge up is not taken as scrolling away.
 */
const LATEST_IN_VIEW_TOLERANCE_PX = 48;
/** How many pages an automatic jump searches, including the newest page. */
const MAX_PAGES_TO_FIND = 10;
/** How long what was jumped to stays pointed out. */
const POINTED_OUT_MS = 2000;

/**
 * A place in a chat's log to go to: a message, or an automation's run, by
 * its chat, where its feed shows it, as its result or as how it went.
 */
export type ChatLogPoint =
	| { kind: "message"; messageId: string }
	| { kind: "run"; runChatId: string };

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
	/** What was just jumped to, pointed out for a moment. */
	pointedOut: ChatLogPoint | undefined;
	/** What was last jumped to, such as the run the chat was opened at. */
	reached: ChatLogPoint | undefined;
	/** Whether the point reached by the current jump is still in view. */
	isReachedInView: () => boolean;
	/** What could not be found after loading as many older pages as the search allows. */
	missingPoint: ChatLogPoint | undefined;
}

/**
 * Keeps a chat's log at its latest message: opened there, and following each
 * new one while the viewer stays at the foot, until they scroll up or jump
 * away: to what the chat was opened at (`focus`), or to a message a quote
 * asks for.
 */
export function useChatLogPosition({
	messages,
	latestItemRevision,
	items,
	focus,
	logReady,
}: {
	messages: MessagePages;
	/** Changes whenever the newest item does; see `chatItemRevision`. */
	latestItemRevision: string;
	/** The items loaded, to tell whether what is jumped to is among them. */
	items: readonly ChatMessageItem[];
	focus: ChatLogPoint | undefined;
	logReady: boolean;
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

	const loadOlder = () => loadOlderKeepingPlace(viewport.current, messages.fetchNextPage);

	const settledAtLatest = useSettledAtLatest(viewport, followingLatest, !messages.isPending);
	const [jumpTarget, jumpTo] = useJumpTarget(focus);
	const jump = useJumpToPoint({
		target: jumpTarget,
		shown: jumpTarget !== undefined && isLoaded(items, jumpTarget.point),
		ready: logReady && settledAtLatest,
		viewport,
		older:
			!messages.isSuccess || messages.isFetchingNextPage
				? "loading"
				: messages.hasNextPage
					? "available"
					: "none",
		loadOlder,
		pagesLoaded: messages.data?.pages.length ?? 0,
		onJumped: (element) => {
			// Reading back from here: new messages no longer pull the chat to its foot.
			followingLatest.current = false;
			positionedAtLatest.current = true;
			lastScrollTop.current = element.scrollTop;
			setLatestInView(atLatest(element));
		},
	});

	useFollowContentGrowth(viewport, followingLatest);
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
		const atFoot = atLatest(element);
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

	function isReachedInView() {
		const element = viewport.current;
		if (!element || !jump.reached) return false;
		const row = elementOf(element, jump.reached);
		if (!row || row.checkVisibility?.({ visibilityProperty: true }) === false) return false;
		const frame = element.getBoundingClientRect();
		const box = row.getBoundingClientRect();
		return box.bottom >= frame.top && box.top <= frame.bottom;
	}

	return {
		attachViewport,
		onScroll,
		latestInView: latestInView && (jumpTarget?.point.kind !== "run" || jump.reached !== undefined),
		settledAtLatest,
		scrollToLatest,
		loadOlder,
		jumpTo,
		pointedOut: jump.pointedOut,
		reached: jump.reached,
		isReachedInView,
		missingPoint: jump.missingPoint,
	};
}

function atLatest(element: HTMLElement): boolean {
	return (
		element.scrollHeight - element.scrollTop - element.clientHeight < LATEST_IN_VIEW_TOLERANCE_PX
	);
}

/** One request to go somewhere in the log. Asking again for the same place is a new request. */
interface JumpTarget {
	point: ChatLogPoint;
}

/**
 * Where to go: what the chat was opened at, until a reply's quote asks for
 * a message, and again whenever the chat is opened at somewhere new.
 */
function useJumpTarget(
	focus: ChatLogPoint | undefined,
): [JumpTarget | undefined, (messageId: string) => void] {
	const [target, setTarget] = useState(() => jumpTargetOf(focus));
	const [openedAt, setOpenedAt] = useState(focus && pointKey(focus));
	if ((focus && pointKey(focus)) !== openedAt) {
		setOpenedAt(focus && pointKey(focus));
		setTarget(jumpTargetOf(focus));
	}
	return [target, (messageId) => setTarget({ point: { kind: "message", messageId } })];
}

function jumpTargetOf(point: ChatLogPoint | undefined): JumpTarget | undefined {
	return point ? { point } : undefined;
}

/** The same for the same place, so the address opening it again is not a new request. */
function pointKey(point: ChatLogPoint): string {
	return point.kind === "message" ? `message:${point.messageId}` : `run:${point.runChatId}`;
}

/** Whether `point` is among `items`: the message, or the run's result or the run itself. */
function isLoaded(items: readonly ChatMessageItem[], point: ChatLogPoint): boolean {
	if (point.kind === "message") {
		return messagesIn(items).some((message) => message.id === point.messageId);
	}
	return items.some((item) =>
		item.kind === "message"
			? item.message.automationResultOf?.chatId === point.runChatId
			: item.kind === "run" && item.chatId === point.runChatId,
	);
}

/**
 * The element the log draws `point` as: a message by its id; a run by its
 * chat, on its result or on the line saying how it went.
 */
function elementOf(viewport: HTMLElement, point: ChatLogPoint): HTMLElement | undefined {
	if (point.kind === "message") {
		return [...viewport.querySelectorAll<HTMLElement>("[data-message-id]")].find(
			(candidate) => candidate.dataset.messageId === point.messageId,
		);
	}
	return [...viewport.querySelectorAll<HTMLElement>("[data-run-chat-id]")].find(
		(candidate) => candidate.dataset.runChatId === point.runChatId,
	);
}

/**
 * Jumps to the target once it is shown, loading older pages until it is, up
 * to a limit, then centres it, moves the focus to it, and points it out for a
 * moment. Each target is jumped to once. Returns what is pointed out, if
 * anything, what was last reached, and whether the search gave up without
 * finding it.
 */
function useJumpToPoint({
	target,
	shown,
	ready,
	viewport,
	older,
	loadOlder,
	pagesLoaded,
	onJumped,
}: {
	target: JumpTarget | undefined;
	/** Whether the target is among the items loaded. */
	shown: boolean;
	ready: boolean;
	viewport: RefObject<HTMLDivElement | null>;
	/** Whether an older page can be loaded now, is on its way, or there is none. */
	older: "available" | "loading" | "none";
	loadOlder: () => Promise<void>;
	pagesLoaded: number;
	onJumped: (element: HTMLElement) => void;
}): {
	pointedOut: ChatLogPoint | undefined;
	reached: ChatLogPoint | undefined;
	missingPoint: ChatLogPoint | undefined;
} {
	const [pointedOut, setPointedOut] = useState<ChatLogPoint>();
	const [reached, setReached] = useState<JumpTarget>();
	const loadOlderPage = useEffectEvent(() => void loadOlder());
	const jumpedTo = useEffectEvent(onJumped);
	useEffect(() => {
		if (!target || reached === target) return;
		if (!shown) {
			if (older === "available" && pagesLoaded < MAX_PAGES_TO_FIND) loadOlderPage();
			return;
		}
		if (!ready) return;
		// In the next frame, after the scroll event from the chat's first move to its
		// foot, which would otherwise say the chat is following its latest again.
		const frame = requestAnimationFrame(() => {
			const element = viewport.current;
			const row = element && elementOf(element, target.point);
			if (!element || !row) return;
			centreIn(element, row);
			row.tabIndex = -1;
			row.focus({ preventScroll: true });
			jumpedTo(element);
			setPointedOut(target.point);
			setReached(target);
		});
		return () => cancelAnimationFrame(frame);
	}, [target, shown, ready, viewport, older, pagesLoaded, reached]);
	useEffect(() => {
		if (!pointedOut) return;
		const fade = setTimeout(() => setPointedOut(undefined), POINTED_OUT_MS);
		return () => clearTimeout(fade);
	}, [pointedOut]);
	const searchedEnough = pagesLoaded >= MAX_PAGES_TO_FIND;
	const missingPoint =
		!shown && older !== "loading" && (older === "none" || searchedEnough)
			? target?.point
			: undefined;
	return {
		pointedOut,
		reached: shown && reached === target ? reached?.point : undefined,
		missingPoint,
	};
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
