import type { Bot } from "@sugabots/contracts";
import { InternalServerError } from "@sugabots/contracts/http";
import { userText } from "@sugabots/errors";
import type { QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { bots, linear, pendingAnswer, personalAssistant, triager } from "@/api.test-support.tsx";
import { client } from "@/client.test-support.ts";
import { findBot, useUpdateBot } from "@/lib/bots.ts";
import { createQueryClient } from "@/lib/query.ts";
import { InRoute } from "@/lib/route.test-support.tsx";

vi.mock("@/api.ts", () => import("@/client.test-support.ts"));

describe("findBot", () => {
	/** Another member's Personal Assistant, as an administrator sees it listed. */
	const someoneElses = {
		...personalAssistant,
		id: "0199a3a0-0000-7000-8000-0000000000be",
		permissions: { ...personalAssistant.permissions, talk: false },
	};
	const secondAssistant = {
		...personalAssistant,
		id: "0199a3a0-0000-7000-8000-0000000000c1",
		handle: "personal-assistant-2",
	};

	it("finds each of the member's own Personal Assistants by the handle it shares with others'", () => {
		const someoneElsesSecond = {
			...someoneElses,
			id: "0199a3a0-0000-7000-8000-0000000000c2",
			handle: "personal-assistant-2",
		};
		const listed = [someoneElses, someoneElsesSecond, ...bots, personalAssistant, secondAssistant];
		expect(findBot(listed, "personal-assistant")).toBe(personalAssistant);
		expect(findBot(listed, "personal-assistant-2")).toBe(secondAssistant);
	});

	it("never finds someone else's Personal Assistant", () => {
		expect(findBot([someoneElses, ...bots], "personal-assistant")).toBeUndefined();
	});
});

describe("quick changes to bots", () => {
	/** The roster as the cache holds it, with every bot in `bots` loaded. */
	function rosterIn(queries: QueryClient): readonly Bot[] | undefined {
		return queries.getQueriesData<readonly Bot[]>({ queryKey: ["bots"] })[0]?.[1];
	}

	/** Each bot's updates, once the route they are made in has rendered. */
	async function renderUpdates(queries: QueryClient) {
		queries.setQueryData(["bots", undefined], bots);
		const rendered = renderHook(
			() => ({ triager: useUpdateBot(triager.id), linear: useUpdateBot(linear.id) }),
			{ wrapper: ({ children }) => <InRoute queries={queries}>{children}</InRoute> },
		);
		await waitFor(() => expect(rendered.result.current).not.toBeNull());
		return rendered;
	}

	it("sends a bot's changes one at a time, in the order made", async () => {
		const first = pendingAnswer();
		client.api.bots.update
			.mockReturnValueOnce(first.effect)
			.mockReturnValueOnce(Effect.succeed({ ...triager, name: "Second" }));
		client.api.bots.list.mockReturnValue(Effect.succeed(bots));
		const { result } = await renderUpdates(createQueryClient());

		await act(async () => {
			result.current.triager.mutate({ name: "First" });
			result.current.triager.mutate({ name: "Second" });
		});
		expect(client.api.bots.update.mock.calls).toEqual([
			[{ params: { botId: triager.id }, payload: { changes: { name: "First" } } }],
		]);

		first.answer(Effect.succeed({ ...triager, name: "First" }));

		await waitFor(() => expect(client.api.bots.update).toHaveBeenCalledTimes(2));
		expect(client.api.bots.update).toHaveBeenLastCalledWith({
			params: { botId: triager.id },
			payload: { changes: { name: "Second" } },
		});
	});

	it("keeps another bot's change shown when one bot's fails", async () => {
		const triagerSave = pendingAnswer();
		const linearSave = pendingAnswer();
		client.api.bots.update
			.mockReturnValueOnce(triagerSave.effect)
			.mockReturnValueOnce(linearSave.effect);
		const queries = createQueryClient();
		const { result } = await renderUpdates(queries);

		act(() => result.current.triager.mutate({ name: "Renamed triager" }));
		act(() => result.current.linear.mutate({ name: "Renamed linear" }));
		await waitFor(() => expect(client.api.bots.update).toHaveBeenCalledTimes(2));
		triagerSave.answer(Effect.fail(new InternalServerError({ message: userText`Nope` })));

		await waitFor(() => expect(result.current.triager.isError).toBe(true));
		expect(rosterIn(queries)?.find((bot) => bot.id === linear.id)?.name).toBe("Renamed linear");
	});
});
