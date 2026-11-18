import type { Agent, AgentUpdate, NewAgent } from "@sugabots/contracts";
import {
	queryOptions,
	skipToken,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";
import { NotReadyError } from "@/lib/failure.ts";
import { useWorkspace } from "@/lib/workspace.ts";

/**
 * The bots in the workspace being looked at.
 *
 * One query for the whole roster, which the sidebar lists and every bot route
 * resolves its handle out of — the same arrangement channels have, and the
 * reason there is no by-id fetch on the way into a page.
 *
 * The API scopes it: every public bot, your own private ones and your
 * Personal Assistant; an administrator also sees others' private bots listed.
 */
export function useAgents(): {
	agents: readonly Agent[] | undefined;
	isPending: boolean;
	error: unknown;
	refetch: () => Promise<{ data?: readonly Agent[] }>;
} {
	const workspace = useWorkspace();
	const query = useQuery(agentsQuery(workspace.workspace?.id));

	return {
		agents: query.data,
		isPending: workspace.isPending || query.isPending,
		error: query.error,
		refetch: query.refetch,
	};
}

/** The bots of one workspace, which need not be the one being looked at. */
export function agentsQuery(workspaceId: string | undefined) {
	return queryOptions({
		queryKey: ["agents", workspaceId],
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(client.api.agents.list({ params: { workspace: workspaceId } }), {
						signal,
					})
			: skipToken,
	});
}

/**
 * The handle every Personal Assistant shares, each person's own; the
 * workspace's other bots' handles are unique.
 */
export const ASSISTANT_HANDLE = "personal-assistant";

/**
 * The bot an address names by its handle. `personal-assistant` names the
 * person's own Personal Assistant, never someone else's.
 */
export function findBot(agents: readonly Agent[] | undefined, handle: string): Agent | undefined {
	if (handle === ASSISTANT_HANDLE) return agents?.find((one) => one.assistant);
	return agents?.find((one) => one.handle === handle);
}

/** The bot at `handle`, once the roster has loaded. */
export function useBot(handle: string): {
	agent: Agent | undefined;
	isPending: boolean;
	error: unknown;
} {
	const { agents, isPending, error } = useAgents();
	return { agent: findBot(agents, handle), isPending, error };
}

/** The bot with `agentId`, or `undefined` until the roster has it. */
export function useAgent(agentId: string | null | undefined): Agent | undefined {
	const { agents } = useAgents();
	return agentId ? agents?.find((one) => one.id === agentId) : undefined;
}

/** The person's own Personal Assistant, once the roster has it. */
export function useAssistant(): Agent | undefined {
	return useAgents().agents?.find((one) => one.assistant);
}

/**
 * Makes sure the person has a Personal Assistant, made on `model` when one is
 * given, and puts it in the roster.
 */
export function useEnsureAssistant() {
	const invalidate = useInvalidateAgents();
	const workspaceId = useWorkspace().workspace?.id;
	return useMutation({
		mutationFn: (model?: string) => {
			if (!workspaceId) throw new NotReadyError();
			return Effect.runPromise(
				client.api.agents.ensureAssistant({
					params: { workspace: workspaceId },
					payload: model === undefined ? {} : { model },
				}),
			);
		},
		onSuccess: invalidate,
	});
}

/** Pins a bot to the person's sidebar, or unpins it. */
export function usePinAgent() {
	const invalidate = useInvalidateAgents();
	return useMutation({
		mutationFn: ({ agentId, pinned }: { agentId: string; pinned: boolean }) =>
			Effect.runPromise(
				pinned
					? client.api.agents.pin({ params: { agentId } })
					: client.api.agents.unpin({ params: { agentId } }),
			),
		onSuccess: invalidate,
	});
}

export function useModels(enabled = true) {
	const workspaceId = useWorkspace().workspace?.id;
	return useQuery({
		queryKey: ["models", workspaceId],
		queryFn:
			workspaceId && enabled
				? ({ signal }) =>
						Effect.runPromise(
							client.api.modelProviders.listEnabledModels({ params: { workspace: workspaceId } }),
							{ signal },
						)
				: skipToken,
	});
}

/**
 * What to call a bot's model: its display name once the workspace's models
 * load, otherwise its id, which also stands for a model since switched off.
 */
export function useModelName(model: string | null): string | null {
	const inUse = useModels(model !== null).data?.models.find(({ modelId }) => modelId === model);
	return inUse?.displayName ?? model;
}

export function useCreateAgent() {
	const invalidate = useInvalidateAgents();
	const workspaceId = useWorkspace().workspace?.id;

	return useMutation({
		mutationFn: (input: NewAgent) => {
			if (!workspaceId) {
				throw new NotReadyError();
			}
			return Effect.runPromise(
				client.api.agents.create({ params: { workspace: workspaceId }, payload: input }),
			);
		},
		onSuccess: invalidate,
	});
}

/**
 * Saves a change to one agent. The roster is patched before the API answers,
 * so a switch moves under the pointer rather than after a round trip, and put
 * back if the save fails. The roster is refetched afterwards either way.
 */
export function useUpdateAgent(agentId: string) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	const invalidate = useInvalidateAgents();
	const rosterKey = ["agents", workspaceId];

	return useMutation({
		mutationFn: (input: AgentUpdate) =>
			Effect.runPromise(client.api.agents.update({ params: { agentId }, payload: input })),
		onMutate: async (input) => {
			await queries.cancelQueries({ queryKey: rosterKey });
			const before = queries.getQueryData<Agent[]>(rosterKey);
			queries.setQueryData<Agent[]>(rosterKey, (roster) =>
				roster?.map((agent) => (agent.id === agentId ? { ...agent, ...input } : agent)),
			);
			return { before };
		},
		onError: (_error, _input, context) => {
			if (context?.before) queries.setQueryData(rosterKey, context.before);
		},
		// Not awaited: the save's outcome should not wait on the roster refetch.
		onSettled: () => {
			void invalidate();
		},
	});
}

export function useDeleteAgent() {
	const invalidate = useInvalidateAgents();

	return useMutation({
		mutationFn: (agentId: string) =>
			Effect.runPromise(client.api.agents.remove({ params: { agentId } })),
		onSuccess: invalidate,
	});
}

function useInvalidateAgents(): () => Promise<void> {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;

	return async () => {
		await Promise.all([
			queries.invalidateQueries({ queryKey: ["agents", workspaceId] }),
			// A bot's tasks list shows it.
			queries.invalidateQueries({ queryKey: ["bot-tasks", workspaceId] }),
		]);
	};
}
