import type { Bot } from "@sugabots/contracts";
import { InternalServerError } from "@sugabots/contracts/http";
import { testMember } from "@sugabots/contracts/testing";
import { userText } from "@sugabots/errors";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { Effect } from "effect";
import { type ReactNode, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findBot, useUpdateBot } from "@/lib/bots.ts";
import { useMembersReachingProject, useProjectBots } from "@/lib/projects.ts";
import { createQueryClient } from "@/lib/query.ts";
import {
	bots,
	juno,
	linear,
	pendingAnswer,
	personalAssistant,
	projects,
	sam,
	triager,
} from "@/test-api.tsx";
import { client } from "@/test-client.ts";

vi.mock("@/api.ts", () => import("@/test-client.ts"));

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("findBot", () => {
	const someoneElses = {
		...personalAssistant,
		id: "0199a3a0-0000-7000-8000-0000000000be",
		assistant: false,
	};

	it("finds the member's own Personal Assistant by the handle every assistant shares", () => {
		expect(findBot([someoneElses, ...bots, personalAssistant], "personal-assistant")).toBe(
			personalAssistant,
		);
	});

	it("never finds someone else's Personal Assistant", () => {
		expect(findBot([someoneElses, ...bots], "personal-assistant")).toBeUndefined();
	});
});

describe("making a bot personal", () => {
	it("asks again who reaches the bot's default project", async () => {
		const reachers = [sam, juno].map(({ id, name }) => testMember({ id, name }));
		client.api.projects.listMembersReaching.mockReturnValue(Effect.succeed(reachers));
		client.api.bots.update.mockReturnValue(
			Effect.succeed({ ...triager, visibility: "personal" as const }),
		);
		const { result } = renderHook(
			() => ({
				members: useMembersReachingProject(triager.defaultProjectId),
				update: useUpdateBot(triager.id),
			}),
			{ wrapper: InRoute },
		);
		await waitFor(() => expect(result.current.members.isSuccess).toBe(true));
		client.api.projects.listMembersReaching.mockReturnValue(Effect.succeed(reachers.slice(0, 1)));

		await act(() => result.current.update.mutateAsync({ visibility: "personal" }));

		await waitFor(() => expect(result.current.members.data).toEqual(reachers.slice(0, 1)));
	});

	it("takes it off the bots lists of the projects it was in", async () => {
		const [project] = projects;
		client.api.projects.listBots.mockReturnValue(Effect.succeed([triager, linear]));
		client.api.bots.update.mockReturnValue(
			Effect.succeed({ ...triager, visibility: "personal" as const }),
		);
		const { result } = renderHook(
			() => ({
				projectBots: useProjectBots(project?.id),
				update: useUpdateBot(triager.id),
			}),
			{ wrapper: InRoute },
		);
		await waitFor(() => expect(result.current.projectBots.isSuccess).toBe(true));
		client.api.projects.listBots.mockReturnValue(Effect.succeed([linear]));

		await act(() => result.current.update.mutateAsync({ visibility: "personal" }));

		await waitFor(() => expect(result.current.projectBots.data).toEqual([linear]));
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

		act(() => result.current.triager.mutate({ name: "First" }));
		act(() => result.current.triager.mutate({ name: "Second" }));
		await waitFor(() => expect(client.api.bots.update).toHaveBeenCalledTimes(1));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(client.api.bots.update).toHaveBeenCalledTimes(1);

		first.answer(Effect.succeed({ ...triager, name: "First" }));

		await waitFor(() => expect(client.api.bots.update).toHaveBeenCalledTimes(2));
		expect(client.api.bots.update).toHaveBeenLastCalledWith({
			params: { botId: triager.id },
			payload: { name: "Second" },
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

/** Renders `children` inside a route, where `useWorkspace` reads the workspace from. */
function InRoute({ children, queries: given }: { children: ReactNode; queries?: QueryClient }) {
	const [queries] = useState(() => given ?? createQueryClient());
	const [router] = useState(() =>
		createRouter({
			routeTree: createRootRoute({ component: () => children }),
			history: createMemoryHistory(),
		}),
	);
	return (
		<QueryClientProvider client={queries}>
			<RouterProvider router={router} />
		</QueryClientProvider>
	);
}
