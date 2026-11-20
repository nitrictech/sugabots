import type { Bot, BotUpdate, NewBot } from "@sugabots/contracts";
import {
	queryOptions,
	skipToken,
	useMutation,
	useMutationState,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { Effect } from "effect";
import { useEffect, useRef } from "react";
import { client } from "@/api.ts";
import { projectThreadsKey } from "@/lib/chats.ts";
import { projectsQuery } from "@/lib/projects.ts";
import { useRequiredWorkspaceId, useWorkspace } from "@/lib/workspace.ts";

/**
 * The bots in the workspace being looked at.
 *
 * One query for the whole roster, which the sidebar lists and every bot route
 * resolves its handle out of.
 *
 * The API scopes it: every public bot, your own private ones and your
 * Personal Assistant; an administrator also sees others' private bots listed.
 */
export function useBots(): {
	bots: readonly Bot[] | undefined;
	isPending: boolean;
	error: unknown;
	refetch: () => Promise<{ data?: readonly Bot[] }>;
} {
	const workspace = useWorkspace();
	const query = useQuery(botsQuery(workspace.workspace?.id));

	return {
		bots: query.data,
		isPending: workspace.isPending || query.isPending,
		error: query.error,
		refetch: query.refetch,
	};
}

/** The bots of one workspace, which need not be the one being looked at. */
export function botsQuery(workspaceId: string | undefined) {
	return queryOptions({
		queryKey: ["bots", workspaceId],
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(client.api.bots.list({ params: { workspace: workspaceId } }), {
						signal,
					})
			: skipToken,
	});
}

/**
 * The handle every Personal Assistant shares, each person's own; the
 * workspace's other bots' handles are unique.
 */
const ASSISTANT_HANDLE = "personal-assistant";

/**
 * The bot an address names by its handle. `personal-assistant` names the
 * person's own Personal Assistant, never someone else's.
 */
export function findBot(bots: readonly Bot[] | undefined, handle: string): Bot | undefined {
	if (handle === ASSISTANT_HANDLE) return bots?.find((one) => one.assistant);
	return bots?.find((one) => one.handle === handle);
}

/** The bot at `handle`, once the roster has loaded. */
export function useBotWithHandle(handle: string): {
	bot: Bot | undefined;
	isPending: boolean;
	error: unknown;
} {
	const { bots, isPending, error } = useBots();
	return { bot: findBot(bots, handle), isPending, error };
}

/** The bot with `botId`, or `undefined` until the roster has it. */
export function useBot(botId: string | null | undefined): Bot | undefined {
	const { bots } = useBots();
	return botId ? bots?.find((one) => one.id === botId) : undefined;
}

/** The person's own Personal Assistant, once the roster has it. */
export function useAssistant(): Bot | undefined {
	return useBots().bots?.find((one) => one.assistant);
}

/**
 * Makes sure the person has a Personal Assistant, made on `model` when one is
 * given, and puts it in the roster.
 */
export function useEnsureAssistant() {
	const invalidate = useInvalidateBots();
	const workspaceId = useRequiredWorkspaceId();
	return useMutation({
		mutationKey: ensureAssistantKey(useWorkspace().workspace?.id),
		mutationFn: (model?: string) =>
			Effect.runPromise(
				client.api.bots.ensureAssistant({
					params: { workspace: workspaceId() },
					payload: model === undefined ? {} : { model },
				}),
			),
		onSuccess: invalidate,
	});
}

/** The mutations that make the person's Personal Assistant in `workspaceId`. */
function ensureAssistantKey(workspaceId: string | undefined) {
	return ["ensure-assistant", workspaceId];
}

/**
 * Makes the person's Personal Assistant, once for each workspace, when its
 * roster has loaded without one. For the workspace's shell alone, so a page
 * however it is reached has one made, and only one request asks;
 * `useEnsuringAssistantFailed` tells a page how it went.
 */
export function useEnsuredAssistant(): void {
	const workspaceId = useWorkspace().workspace?.id;
	const { isPending, error } = useBots();
	const assistant = useAssistant();
	const missing = !isPending && !error && !assistant;
	const { mutate } = useEnsureAssistant();
	const ensuredIn = useRef<string | undefined>(undefined);
	useEffect(() => {
		if (!missing || !workspaceId || ensuredIn.current === workspaceId) return;
		ensuredIn.current = workspaceId;
		mutate(undefined);
	}, [missing, workspaceId, mutate]);
}

/** Whether making the person's Personal Assistant in the workspace last failed. */
export function useEnsuringAssistantFailed(): boolean {
	const workspaceId = useWorkspace().workspace?.id;
	const statuses = useMutationState({
		filters: { mutationKey: ensureAssistantKey(workspaceId) },
		select: (mutation) => mutation.state.status,
	});
	return statuses.at(-1) === "error";
}

/** Pins a bot to the person's sidebar, or unpins it. */
export function usePinBot() {
	const invalidate = useInvalidateBots();
	return useMutation({
		mutationFn: ({ botId, pinned }: { botId: string; pinned: boolean }) =>
			Effect.runPromise(
				pinned
					? client.api.bots.pin({ params: { botId } })
					: client.api.bots.unpin({ params: { botId } }),
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

export function useCreateBot() {
	const invalidate = useInvalidateBots();
	const workspaceId = useRequiredWorkspaceId();

	return useMutation({
		mutationFn: (input: NewBot) =>
			Effect.runPromise(
				client.api.bots.create({ params: { workspace: workspaceId() }, payload: input }),
			),
		onSuccess: invalidate,
	});
}

/**
 * Saves a change to one bot. The roster is patched before the API answers,
 * so a switch moves under the pointer rather than after a round trip. Changes
 * to one bot are sent one at a time, in the order made, so the last one made
 * is the one kept. The roster is refetched once every bot's changes are
 * settled, which also takes back any that failed; while none are left, a
 * failed one is put back at once.
 */
export function useUpdateBot(botId: string) {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;
	const invalidate = useInvalidateBots();
	const rosterKey = ["bots", workspaceId];
	const mutationKey = ["bot-update", workspaceId];
	// Counts this change itself until its own callbacks are done.
	const othersPending = () => queries.isMutating({ mutationKey }) > 1;

	return useMutation({
		mutationKey,
		scope: { id: `bot-update:${botId}` },
		mutationFn: (input: BotUpdate) =>
			Effect.runPromise(client.api.bots.update({ params: { botId }, payload: input })),
		onMutate: async (input) => {
			await queries.cancelQueries({ queryKey: rosterKey });
			const before = queries.getQueryData<Bot[]>(rosterKey)?.find((bot) => bot.id === botId);
			queries.setQueryData<Bot[]>(rosterKey, (roster) =>
				roster?.map((bot) => (bot.id === botId ? { ...bot, ...input } : bot)),
			);
			return { before };
		},
		onError: (_error, _input, context) => {
			const before = context?.before;
			// Changes still on their way are shown over it; the refetch after the last sorts it out.
			if (!before || othersPending()) return;
			queries.setQueryData<Bot[]>(rosterKey, (roster) =>
				roster?.map((bot) => (bot.id === botId ? before : bot)),
			);
		},
		onSuccess: (bot, input) => {
			// Whoever reaches the bot reaches its default project, and making a bot
			// public or private changes who that is.
			if (input.visibility !== undefined) {
				void queries.invalidateQueries({ queryKey: ["project-people", bot.defaultProjectId] });
			}
		},
		// Not awaited: the save's outcome should not wait on the roster refetch.
		onSettled: () => {
			if (othersPending()) return;
			void invalidate();
		},
	});
}

export function useDeleteBot() {
	const invalidate = useInvalidateBots();

	return useMutation({
		mutationFn: (botId: string) => Effect.runPromise(client.api.bots.remove({ params: { botId } })),
		onSuccess: invalidate,
	});
}

function useInvalidateBots(): () => Promise<void> {
	const queries = useQueryClient();
	const workspaceId = useWorkspace().workspace?.id;

	return async () => {
		await Promise.all([
			queries.invalidateQueries({ queryKey: ["bots", workspaceId] }),
			// A bot's threads list shows it.
			queries.invalidateQueries({ queryKey: projectThreadsKey(workspaceId) }),
			// So do the bots lists of the projects it is in, which the list of
			// projects counts. A bot made private or deleted leaves every project.
			queries.invalidateQueries({ queryKey: ["project-bots"] }),
			queries.invalidateQueries({ queryKey: projectsQuery(workspaceId).queryKey }),
		]);
	};
}
