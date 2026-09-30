import "fake-indexeddb/auto";
import {
	persistQueryClientRestore,
	persistQueryClientSave,
} from "@tanstack/react-query-persist-client";
import { afterEach, describe, expect, it } from "vitest";
import { createQueryClient } from "@/lib/query.ts";
import { forgetSavedQueries, savedQueriesFor } from "@/lib/query-persistence.ts";

const SAM = "0199a3a0-0000-7000-8000-000000000001";
const ALEX = "0199a3a0-0000-7000-8000-000000000002";

/** Saves a client holding a chat's messages and an unsent message, as `userId`'s last visit would. */
async function saveVisit(userId: string) {
	const { persistOptions, saveWhileMounted } = savedQueriesFor(userId);
	const stop = saveWhileMounted();
	const queryClient = createQueryClient();
	queryClient.setQueryData(["chat-messages", "chat-1"], { pages: [{ items: [] }], pageParams: [] });
	queryClient.setQueryData(["chat-optimistic", "chat-1"], [{ unsent: true }]);
	await persistQueryClientSave({ queryClient, ...persistOptions });
	return { stop, persistOptions };
}

/** What `userId`'s next visit starts from. */
async function restoreVisit(userId: string) {
	const queryClient = createQueryClient();
	await persistQueryClientRestore({ queryClient, ...savedQueriesFor(userId).persistOptions });
	return queryClient;
}

afterEach(forgetSavedQueries);

describe("saved queries", () => {
	it("gives a person's next visit the chats they left, but not what was still unsent", async () => {
		await saveVisit(SAM);

		const next = await restoreVisit(SAM);
		expect(next.getQueryData(["chat-messages", "chat-1"])).toEqual({
			pages: [{ items: [] }],
			pageParams: [],
		});
		expect(next.getQueryData(["chat-optimistic", "chat-1"])).toBeUndefined();
	});

	it("keeps each person's saved chats to themselves", async () => {
		await saveVisit(SAM);

		expect((await restoreVisit(ALEX)).getQueryData(["chat-messages", "chat-1"])).toBeUndefined();
	});

	it("keeps nothing once nobody is signed in", async () => {
		await saveVisit(SAM);
		await forgetSavedQueries();

		expect((await restoreVisit(SAM)).getQueryData(["chat-messages", "chat-1"])).toBeUndefined();
	});

	it("writes nothing when a save falls due after sign-out has cleared it", async () => {
		const { stop, persistOptions } = await saveVisit(SAM);
		stop();
		await forgetSavedQueries();

		// The visit's batched save, arriving late.
		const late = createQueryClient();
		late.setQueryData(["chat-messages", "chat-1"], { pages: [], pageParams: [] });
		await persistQueryClientSave({ queryClient: late, ...persistOptions });

		expect((await restoreVisit(SAM)).getQueryData(["chat-messages", "chat-1"])).toBeUndefined();
	});
});
