import {
	type NotificationContent,
	type NotificationPreferences,
	type NotificationSettings,
	streamEvent,
} from "@sugabots/contracts";
import { Unauthorized } from "@sugabots/contracts/http";
import { userText } from "@sugabots/errors";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { Effect } from "effect";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { pendingAnswer, sam } from "@/api.test-support.tsx";
import { client } from "@/client.test-support.ts";
import {
	useChangeNotificationPreferences,
	useNotificationsInThisBrowser,
} from "@/lib/notifications.ts";
import { createQueryClient } from "@/lib/query.ts";
import { SessionContext } from "@/lib/session.ts";

vi.mock("@/api.ts", () => import("@/client.test-support.ts"));
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
});

const release = crypto.randomUUID();
const otherTab = crypto.randomUUID();

const about = (chatId: string, title: string): NotificationContent => ({
	title,
	body: "Shipped.",
	tag: `chat:${chatId}`,
	path: "/",
	chatId,
});

/** The member's own event stream, carrying `events` and then ending. */
function memberStream(...events: ReturnType<typeof streamEvent>[]) {
	client.events.me.mockReturnValue({
		async *[Symbol.asyncIterator]() {
			yield* events;
		},
		close: vi.fn(),
	});
}

/** Signed in as Sam; `refresh` is what asking about the session again does. */
function signedIn(refresh: () => Promise<void> = async () => {}) {
	return { member: sam, error: undefined, refresh };
}

/** The browser's notifications as the app runs them: under its query cache and Sam's session. */
const inApp =
	(queries = createQueryClient(), session = signedIn()) =>
	({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queries}>
			<SessionContext value={session}>{children}</SessionContext>
		</QueryClientProvider>
	);

const withQueries = inApp();

it("refreshes the approvals list on the member’s own stream", async () => {
	const queries = createQueryClient();
	const invalidate = vi.spyOn(queries, "invalidateQueries");
	memberStream(streamEvent("approvals.changed", { toolCallId: crypto.randomUUID() }));
	renderHook(useNotificationsInThisBrowser, { wrapper: inApp(queries) });
	await waitFor(() =>
		expect(invalidate).toHaveBeenCalledWith(
			expect.objectContaining({ queryKey: ["workspace-approvals"] }),
		),
	);
});

it("asks about the member's session again when their own stream ends with it", async () => {
	const refresh = vi.fn(async () => {});
	client.events.me.mockReturnValue({
		// biome-ignore lint/correctness/useYield: a stream the server refuses yields nothing.
		async *[Symbol.asyncIterator]() {
			throw new Unauthorized({ message: userText`Invalid or expired session` });
		},
		close: vi.fn(),
	});

	renderHook(useNotificationsInThisBrowser, {
		wrapper: inApp(createQueryClient(), signedIn(refresh)),
	});

	await waitFor(() => expect(refresh).toHaveBeenCalled());
});

it("shows a notification about a chat none of the member's tabs is looking at", async () => {
	memberStream(streamEvent("notification", about(release, "Scout in Release notes")));

	renderHook(useNotificationsInThisBrowser, { wrapper: withQueries });

	await waitFor(() => expect(shown).toEqual(["Scout in Release notes"]));
});

it("holds back a notification about a chat another of their tabs is looking at, until it looks away", async () => {
	memberStream(
		streamEvent("presence", { clientId: otherTab, chatId: release, sequence: 2 }),
		streamEvent("notification", about(release, "Held back")),
		streamEvent("notification", about(crypto.randomUUID(), "Elsewhere")),
		// Sent before the report above, and arriving after it.
		streamEvent("presence", { clientId: otherTab, chatId: null, sequence: 1 }),
		streamEvent("notification", about(release, "Held back too")),
		streamEvent("presence", { clientId: otherTab, chatId: null, sequence: 3 }),
		streamEvent("notification", about(release, "After looking away")),
	);

	renderHook(useNotificationsInThisBrowser, { wrapper: withQueries });

	await waitFor(() => expect(shown).toEqual(["Elsewhere", "After looking away"]));
});

it("sends a second quick preference change over the first, not over what both started from", async () => {
	const before: NotificationSettings = {
		level: "mentions",
		pausedUntil: null,
		quietHours: null,
		turnFailures: true,
		automationRuns: "failures",
		projects: {},
		bots: {},
		mutedUntil: { projects: {}, bots: {} },
	};
	const first = pendingAnswer();
	client.api.notifications.updatePreferences
		.mockReturnValueOnce(first.effect)
		.mockImplementationOnce(({ payload }: { payload: NotificationPreferences }) =>
			Effect.succeed({ ...before, ...payload }),
		);
	const queries = createQueryClient();
	queries.setQueryData(["notification-settings"], before);
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queries}>{children}</QueryClientProvider>
	);
	const { result } = renderHook(() => useChangeNotificationPreferences(), { wrapper });

	act(() => result.current({ turnFailures: false }));
	act(() => result.current({ automationRuns: "all" }));
	first.answer(Effect.succeed({ ...before, turnFailures: false }));

	await waitFor(() => expect(client.api.notifications.updatePreferences).toHaveBeenCalledTimes(2));
	expect(client.api.notifications.updatePreferences).toHaveBeenLastCalledWith({
		payload: expect.objectContaining({ turnFailures: false, automationRuns: "all" }),
	});
});
