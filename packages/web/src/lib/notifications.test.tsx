import { type NotificationContent, streamEvent } from "@sugabots/contracts";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useNotificationsInThisBrowser } from "@/lib/notifications.ts";
import { client } from "@/test-client.ts";

vi.mock("@/api.ts", () => import("@/test-client.ts"));
vi.mock("@tanstack/react-router", async (original) => ({
	...(await original<typeof import("@tanstack/react-router")>()),
	useRouter: () => ({ history: { push: vi.fn() } }),
}));

/** The titles of the notifications this tab showed. */
const shown: string[] = [];

class FakeNotification {
	static permission = "granted";
	onclick: (() => void) | null = null;
	onclose: (() => void) | null = null;
	constructor(title: string) {
		shown.push(title);
	}
	close() {}
}

beforeEach(() => {
	shown.length = 0;
	vi.stubGlobal("Notification", FakeNotification);
	localStorage.setItem("sugabots-notifications-on", "1");
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	localStorage.clear();
	vi.clearAllMocks();
});

const release = crypto.randomUUID();
const otherTab = crypto.randomUUID();

const about = (conversationId: string, title: string): NotificationContent => ({
	title,
	body: "Shipped.",
	tag: `conversation:${conversationId}`,
	path: "/",
	conversationId,
});

/** The person's own event stream, carrying `events` and then ending. */
function personStream(...events: ReturnType<typeof streamEvent>[]) {
	client.events.me.mockReturnValue({
		async *[Symbol.asyncIterator]() {
			yield* events;
		},
		close: vi.fn(),
	});
}

it("shows a notification about a conversation none of the person's tabs is looking at", async () => {
	personStream(streamEvent("notification", about(release, "Scout in Release notes")));

	renderHook(useNotificationsInThisBrowser);

	await waitFor(() => expect(shown).toEqual(["Scout in Release notes"]));
});

it("holds back a notification about a conversation another of their tabs is looking at, until it looks away", async () => {
	personStream(
		streamEvent("presence", { clientId: otherTab, conversationId: release, sequence: 2 }),
		streamEvent("notification", about(release, "Held back")),
		streamEvent("notification", about(crypto.randomUUID(), "Elsewhere")),
		// Sent before the report above, and arriving after it.
		streamEvent("presence", { clientId: otherTab, conversationId: null, sequence: 1 }),
		streamEvent("notification", about(release, "Held back too")),
		streamEvent("presence", { clientId: otherTab, conversationId: null, sequence: 3 }),
		streamEvent("notification", about(release, "After looking away")),
	);

	renderHook(useNotificationsInThisBrowser);

	await waitFor(() => expect(shown).toEqual(["Elsewhere", "After looking away"]));
});
