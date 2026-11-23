import type { ConnectorAccess, ConnectorWithTools } from "@sugabots/contracts";
import { InternalServerError } from "@sugabots/contracts/http";
import {
	connectorWithTools,
	listedConnector,
	type TestConnector,
} from "@sugabots/contracts/testing";
import { userText } from "@sugabots/errors";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { Effect } from "effect";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useConnectorActions, useMarkedConnectors } from "@/lib/connectors.ts";
import { createQueryClient } from "@/lib/query.ts";
import { bots, pendingAnswer, projects } from "@/test-api.tsx";
import { client } from "@/test-client.ts";

vi.mock("@/api.ts", () => import("@/test-client.ts"));

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

const project = projects[0] as (typeof projects)[number];
/** Two of the project's bots, each with connectors of its own. */
const [speaker, listener] = bots as [(typeof bots)[number], (typeof bots)[number]];

const linear: TestConnector = {
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

describe("useMarkedConnectors", () => {
	it("names a connector by its name after it was renamed", async () => {
		client.api.connectors.list.mockReturnValue(Effect.succeed([listedConnector(linear)]));
		const queries = createQueryClient();
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queries}>{children}</QueryClientProvider>
		);
		const { result } = renderHook(() => useMarkedConnectors([speaker.id], project.id), { wrapper });
		await waitFor(() => expect(result.current(speaker.id).get("linear")?.name).toBe("Linear"));

		client.api.connectors.list.mockReturnValue(
			Effect.succeed([listedConnector({ ...linear, name: "Linear (Acme)" })]),
		);
		await act(() => queries.invalidateQueries({ queryKey: ["connectors", project.id] }));

		await waitFor(() =>
			expect(result.current(speaker.id).get("linear")?.name).toBe("Linear (Acme)"),
		);
	});

	it("names a bot's call by the project's connector where the bot's own has its handle too", async () => {
		const ownLinear = { ...linear, projectId: speaker.defaultProjectId, name: "Own Linear" };
		answerConnectors({ [project.id]: [linear], [speaker.defaultProjectId]: [ownLinear] });
		const { result } = renderMarkedConnectors([speaker.id]);

		await waitFor(() => expect(result.current(speaker.id).get("linear")?.name).toBe("Linear"));
	});

	it("never names one bot's call by another bot's own connector", async () => {
		const othersLinear = { ...linear, projectId: listener.defaultProjectId, name: "Their Linear" };
		answerConnectors({ [project.id]: [], [listener.defaultProjectId]: [othersLinear] });
		const { result } = renderMarkedConnectors([speaker.id, listener.id]);

		await waitFor(() =>
			expect(result.current(listener.id).get("linear")?.name).toBe("Their Linear"),
		);
		expect(result.current(speaker.id).get("linear")).toBeUndefined();
	});
});

/** Each project's connectors, as `connectorsByProject` lists them. */
function answerConnectors(connectorsByProject: Record<string, TestConnector[]>) {
	client.api.connectors.list.mockImplementation(({ params }: { params: { projectId: string } }) =>
		Effect.succeed((connectorsByProject[params.projectId] ?? []).map(listedConnector)),
	);
}

/** The marked connectors of `project`'s chat where `botIds` spoke, with the bots' roster loaded. */
function renderMarkedConnectors(botIds: string[]) {
	const queries = createQueryClient();
	queries.setQueryData(["bots", project.workspaceId], bots);
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queries}>{children}</QueryClientProvider>
	);
	return renderHook(() => useMarkedConnectors(botIds, project.id), { wrapper });
}

describe("quick changes to what bots may do with a connector's tools", () => {
	const withTool: TestConnector = {
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
	const detailKey = ["connectors", project.id, linear.id];

	function renderActions() {
		const queries = createQueryClient();
		queries.setQueryData(["connectors", project.id], [listedConnector(withTool)]);
		queries.setQueryData(detailKey, connectorWithTools(withTool));
		client.api.connectors.list.mockReturnValue(Effect.succeed([listedConnector(withTool)]));
		client.api.connectors.get.mockReturnValue(Effect.succeed(connectorWithTools(withTool)));
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queries}>{children}</QueryClientProvider>
		);
		const { result } = renderHook(() => useConnectorActions(project.id), { wrapper });
		const choose = (access: ConnectorAccess) =>
			act(() =>
				result.current.update.mutate({
					connectorId: linear.id,
					json: { toolAccess: { create_issue: access } },
				}),
			);
		const shownAccess = () => queries.getQueryData<ConnectorWithTools>(detailKey)?.tools[0]?.access;
		return { choose, shownAccess };
	}

	it("sends them one at a time, in the order chosen", async () => {
		const first = pendingAnswer();
		client.api.connectors.update
			.mockReturnValueOnce(first.effect)
			.mockReturnValueOnce(Effect.succeed(undefined));
		const { choose } = renderActions();

		choose("allow");
		choose("off");
		await waitFor(() => expect(client.api.connectors.update).toHaveBeenCalledTimes(1));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(client.api.connectors.update).toHaveBeenCalledTimes(1);

		first.answer(Effect.succeed(undefined));

		await waitFor(() => expect(client.api.connectors.update).toHaveBeenCalledTimes(2));
		expect(client.api.connectors.update).toHaveBeenLastCalledWith(
			expect.objectContaining({ payload: { toolAccess: { create_issue: "off" } } }),
		);
	});

	it("keeps showing a later choice while it is sent, when an earlier one fails", async () => {
		const first = pendingAnswer();
		const second = pendingAnswer();
		client.api.connectors.update
			.mockReturnValueOnce(first.effect)
			.mockReturnValueOnce(second.effect);
		const { choose, shownAccess } = renderActions();

		choose("allow");
		choose("off");
		await waitFor(() => expect(shownAccess()).toBe("off"));
		first.answer(Effect.fail(new InternalServerError({ message: userText`Nope` })));

		await waitFor(() => expect(client.api.connectors.update).toHaveBeenCalledTimes(2));
		expect(shownAccess()).toBe("off");
	});
});
