import type { ConnectionAccess, ConnectionWithTools } from "@sugabots/contracts";
import { InternalServerError } from "@sugabots/contracts/http";
import {
	connectionWithTools,
	listedConnection,
	type TestConnection,
} from "@sugabots/contracts/testing";
import { userText } from "@sugabots/errors";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { Effect } from "effect";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useConnectionActions, useConnectionLooks } from "@/lib/connections.ts";
import { createQueryClient } from "@/lib/query.ts";
import { bots, pendingAnswer, projects } from "@/test-api.tsx";
import { client } from "@/test-client.ts";

vi.mock("@/api.ts", () => import("@/test-client.ts"));

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

const project = projects[0] as (typeof projects)[number];
/** Two of the project's bots, each with connections of its own. */
const [speaker, listener] = bots as [(typeof bots)[number], (typeof bots)[number]];

const linear: TestConnection = {
	id: "0199a3a0-0000-7000-8000-0000000007a1",
	workspaceId: project.workspaceId,
	projectId: project.id,
	name: "Linear",
	handle: "linear",
	url: "https://mcp.linear.app/mcp",
	kind: "mcp",
	auth: "oauth",
	signedIn: true,
	signInExpired: false,
	secretHeader: null,
	hasSecret: false,
	appSettingsUrl: null,
	status: "connected",
	tools: [],
	lastTestError: null,
	connectedBy: null,
	createdAt: "2026-09-18T08:00:00.000Z",
};

describe("useConnectionLooks", () => {
	it("names a connection by its name after it was renamed", async () => {
		client.api.connections.list.mockReturnValue(Effect.succeed([listedConnection(linear)]));
		const queries = createQueryClient();
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queries}>{children}</QueryClientProvider>
		);
		const { result } = renderHook(() => useConnectionLooks([speaker.id], project.id), { wrapper });
		await waitFor(() => expect(result.current(speaker.id).get("linear")?.name).toBe("Linear"));

		client.api.connections.list.mockReturnValue(
			Effect.succeed([listedConnection({ ...linear, name: "Linear (Acme)" })]),
		);
		await act(() => queries.invalidateQueries({ queryKey: ["connections", project.id] }));

		await waitFor(() =>
			expect(result.current(speaker.id).get("linear")?.name).toBe("Linear (Acme)"),
		);
	});

	it("names a bot's call by the project's connection where the bot's own has its handle too", async () => {
		const ownLinear = { ...linear, projectId: speaker.defaultProjectId, name: "Own Linear" };
		answerConnections({ [project.id]: [linear], [speaker.defaultProjectId]: [ownLinear] });
		const { result } = renderLooks([speaker.id]);

		await waitFor(() => expect(result.current(speaker.id).get("linear")?.name).toBe("Linear"));
	});

	it("never names one bot's call by another bot's own connection", async () => {
		const othersLinear = { ...linear, projectId: listener.defaultProjectId, name: "Their Linear" };
		answerConnections({ [project.id]: [], [listener.defaultProjectId]: [othersLinear] });
		const { result } = renderLooks([speaker.id, listener.id]);

		await waitFor(() =>
			expect(result.current(listener.id).get("linear")?.name).toBe("Their Linear"),
		);
		expect(result.current(speaker.id).get("linear")).toBeUndefined();
	});
});

/** Each project's connections, as `connectionsByProject` lists them. */
function answerConnections(connectionsByProject: Record<string, TestConnection[]>) {
	client.api.connections.list.mockImplementation(({ params }: { params: { projectId: string } }) =>
		Effect.succeed((connectionsByProject[params.projectId] ?? []).map(listedConnection)),
	);
}

/** The looks of `project`'s conversation where `botIds` spoke, with the bots' roster loaded. */
function renderLooks(botIds: string[]) {
	const queries = createQueryClient();
	queries.setQueryData(["bots", project.workspaceId], bots);
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queries}>{children}</QueryClientProvider>
	);
	return renderHook(() => useConnectionLooks(botIds, project.id), { wrapper });
}

describe("quick changes to what bots may do with a connection's tools", () => {
	const withTool: TestConnection = {
		...linear,
		tools: [
			{
				name: "create_issue",
				description: null,
				readOnly: false,
				destructive: false,
				access: "ask",
			},
		],
	};
	const detailKey = ["connections", project.id, linear.id];

	function renderActions() {
		const queries = createQueryClient();
		queries.setQueryData(["connections", project.id], [listedConnection(withTool)]);
		queries.setQueryData(detailKey, connectionWithTools(withTool));
		client.api.connections.list.mockReturnValue(Effect.succeed([listedConnection(withTool)]));
		client.api.connections.get.mockReturnValue(Effect.succeed(connectionWithTools(withTool)));
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queries}>{children}</QueryClientProvider>
		);
		const { result } = renderHook(() => useConnectionActions(project.id), { wrapper });
		const choose = (access: ConnectionAccess) =>
			act(() =>
				result.current.update.mutate({
					connectionId: linear.id,
					json: { toolAccess: { create_issue: access } },
				}),
			);
		const shownAccess = () =>
			queries.getQueryData<ConnectionWithTools>(detailKey)?.tools[0]?.access;
		return { choose, shownAccess };
	}

	it("sends them one at a time, in the order chosen", async () => {
		const first = pendingAnswer();
		client.api.connections.update
			.mockReturnValueOnce(first.effect)
			.mockReturnValueOnce(Effect.succeed(undefined));
		const { choose } = renderActions();

		choose("allow");
		choose("off");
		await waitFor(() => expect(client.api.connections.update).toHaveBeenCalledTimes(1));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(client.api.connections.update).toHaveBeenCalledTimes(1);

		first.answer(Effect.succeed(undefined));

		await waitFor(() => expect(client.api.connections.update).toHaveBeenCalledTimes(2));
		expect(client.api.connections.update).toHaveBeenLastCalledWith(
			expect.objectContaining({ payload: { toolAccess: { create_issue: "off" } } }),
		);
	});

	it("keeps showing a later choice while it is sent, when an earlier one fails", async () => {
		const first = pendingAnswer();
		const second = pendingAnswer();
		client.api.connections.update
			.mockReturnValueOnce(first.effect)
			.mockReturnValueOnce(second.effect);
		const { choose, shownAccess } = renderActions();

		choose("allow");
		choose("off");
		await waitFor(() => expect(shownAccess()).toBe("off"));
		first.answer(Effect.fail(new InternalServerError({ message: userText`Nope` })));

		await waitFor(() => expect(client.api.connections.update).toHaveBeenCalledTimes(2));
		expect(shownAccess()).toBe("off");
	});
});
