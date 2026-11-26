import type { Bot, BotUpdate, NewBot } from "@sugabots/contracts";
import {
	queryOptions,
	skipToken,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";
import { projectChatsKey } from "@/lib/chats.ts";
import { botRouteAddress } from "@/lib/links.ts";
import { projectsQuery } from "@/lib/projects.ts";
import { useRequiredWorkspaceId, useWorkspace } from "@/lib/workspace.ts";

/**
 * The bots in the workspace being looked at.
 *
 * One query for the whole roster, which the sidebar lists and every bot route
 * resolves its handle out of.
 *
 * The API scopes it: every public bot and your own personal ones, your
 * Personal Assistants included; an administrator also sees others' personal
 * bots listed, their Personal Assistants included.
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
 * Whether `bot` is one of the member's own Personal Assistants, rather than
 * another member's, which an administrator sees listed but can't talk to.
 */
export function isOwnAssistant(bot: Bot): boolean {
	return bot.assistant && bot.permissions.talk;
}

/**
 * The bot an address names by its handle. Every member's Personal Assistants
 * share handles such as `personal-assistant`, so one of those names the
 * member's own, never someone else's; the workspace's other bots' handles are
 * unique.
 */
export function findBot(bots: readonly Bot[] | undefined, address: string): Bot | undefined {
	const ownAssistant = bots?.find((one) => isOwnAssistant(one) && one.handle === address);
	return ownAssistant ?? bots?.find((one) => botRouteAddress(one) === address);
}

/** The bot at `address`, once the roster has loaded. */
export function useBotAtAddress(address: string): {
	bot: Bot | undefined;
	isPending: boolean;
	error: unknown;
} {
	const { bots, isPending, error } = useBots();
	return { bot: findBot(bots, address), isPending, error };
}

/** The bot with `botId`, or `undefined` until the roster has it. */
export function useBot(botId: string | null | undefined): Bot | undefined {
	const { bots } = useBots();
	return botId ? bots?.find((one) => one.id === botId) : undefined;
}

/** The member's own Personal Assistants among `bots`, oldest first. */
export function ownAssistants(bots: readonly Bot[] | undefined): readonly Bot[] {
	return (bots ?? [])
		.filter(isOwnAssistant)
		.toSorted(
			(one, other) =>
				(one.createdAt ?? "").localeCompare(other.createdAt ?? "") ||
				one.id.localeCompare(other.id),
		);
}

/** Makes the member another Personal Assistant, and puts it in the roster. */
export function useCreateAssistant() {
	const invalidate = useInvalidateBots();
	const workspaceId = useRequiredWorkspaceId();
	return useMutation({
		mutationFn: () =>
			Effect.runPromise(client.api.bots.createAssistant({ params: { workspace: workspaceId() } })),
		onSuccess: invalidate,
	});
}

/** Pins a bot to the member's sidebar, or unpins it. */
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
			// A bot's chats list shows it.
			queries.invalidateQueries({ queryKey: projectChatsKey(workspaceId) }),
			// So do the bots lists of the projects it is in, which the list of
			// projects counts. A bot made personal or deleted leaves every project.
			queries.invalidateQueries({ queryKey: ["project-bots"] }),
			queries.invalidateQueries({ queryKey: projectsQuery(workspaceId).queryKey }),
		]);
	};
}

/**
 * Whose `kind` of bot someone else's personal bot is, by its creator's name,
 * so an admin can tell apart bots that share one, as every member's first
 * Personal Assistant does.
 */
export function whoseBot(bot: Bot, kind: string): string {
	return bot.createdBy ? `${bot.createdBy.name}'s ${kind}` : `Someone else's ${kind}`;
}
