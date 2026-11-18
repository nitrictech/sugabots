import type {
	AutomationCurrentSecret,
	AutomationTriggerInput,
	AutomationUpdate,
	AutomationWriteResult,
	NewAutomation,
} from "@sugabots/contracts";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";

/** Every automation query starts with this, so one change refreshes the workspace list and each bot's. */
const AUTOMATIONS_KEY = "automations";

export function useWorkspaceAutomations(workspaceId: string | undefined) {
	return useQuery({
		queryKey: [AUTOMATIONS_KEY, "workspace", workspaceId],
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(
						client.api.automations.listInWorkspace({ params: { workspace: workspaceId } }),
						{ signal },
					)
			: skipToken,
	});
}

/** How many of an automation's latest runs its page shows. */
export const RECENT_RUN_COUNT = 5;

/** How often the runs are read again while one has not ended, so its status stays current. */
const RUN_POLL_MS = 3_000;

/**
 * An automation's latest runs, newest first, read again while one is queued or
 * running. Nothing is asked while `enabled` is false, as for somebody who
 * manages a bot's automations without reaching the bot, whom the API refuses.
 */
export function useRecentRuns({
	botId,
	automationId,
	enabled = true,
}: {
	botId: string;
	automationId: string;
	enabled?: boolean;
}) {
	return useQuery({
		enabled,
		queryKey: [AUTOMATIONS_KEY, "runs", automationId],
		queryFn: ({ signal }) =>
			Effect.runPromise(
				client.api.automations.runs({
					params: { botId, automationId },
					query: { limit: RECENT_RUN_COUNT },
				}),
				{ signal },
			),
		refetchInterval: (query) =>
			query.state.data?.items.some((run) => run.state === "queued" || run.state === "running")
				? RUN_POLL_MS
				: false,
	});
}

/** The bot `botId`'s automations in full; nothing is asked while it is undefined. */
export function useAutomations(botId: string | undefined) {
	return useQuery({
		queryKey: [AUTOMATIONS_KEY, "bot", botId],
		queryFn: botId
			? ({ signal }) =>
					Effect.runPromise(client.api.automations.list({ params: { botId } }), { signal })
			: skipToken,
	});
}

/** Webhook secrets, by trigger, kept out of `AUTOMATIONS_KEY` so refreshing the lists doesn't read them again. */
const SECRET_KEY = "automation-secret";

/** One of an automation's triggers, through the bot the automation belongs to. */
export interface TriggerAddress {
	botId: string;
	automationId: string;
	triggerId: string;
}

/**
 * A webhook trigger's current secret, for somebody who manages it. Nothing
 * is read for anybody else, since the API would refuse them.
 */
export function useAutomationSecret({
	canManage,
	...address
}: TriggerAddress & { canManage: boolean }) {
	return useQuery({
		queryKey: [SECRET_KEY, address.triggerId],
		queryFn: canManage
			? ({ signal }) =>
					Effect.runPromise(client.api.automations.getSecret({ params: address }), { signal })
			: skipToken,
	});
}

/** Each change names the bot its automation belongs to, since automations are addressed through their bot. */
export function useAutomationActions() {
	const queries = useQueryClient();
	const refresh = () =>
		Promise.all([
			queries.invalidateQueries({ queryKey: [AUTOMATIONS_KEY] }),
			// A bot's list holds its automations, by name and how they stand.
			queries.invalidateQueries({ queryKey: ["bot-tasks"] }),
		]);
	const keepSecret = (triggerId: string, current: AutomationCurrentSecret) =>
		queries.setQueryData([SECRET_KEY, triggerId], current);
	const written = (result: AutomationWriteResult) => {
		for (const { triggerId, secret } of result.secrets)
			keepSecret(triggerId, { kind: "set", secret });
		// A webhook given no new secret kept the one it had, or was left without.
		const made = new Set(result.secrets.map((one) => one.triggerId));
		for (const trigger of result.automation.triggers) {
			if (trigger.kind === "webhook" && !made.has(trigger.id)) {
				void queries.invalidateQueries({ queryKey: [SECRET_KEY, trigger.id] });
			}
		}
		return refresh();
	};
	const { automations } = client.api;

	return {
		create: useMutation({
			mutationFn: ({ botId, json }: { botId: string; json: NewAutomation }) =>
				Effect.runPromise(automations.create({ params: { botId }, payload: json })),
			onSuccess: written,
		}),
		update: useMutation({
			mutationFn: ({
				botId,
				automationId,
				json,
			}: {
				botId: string;
				automationId: string;
				json: AutomationUpdate;
			}) =>
				Effect.runPromise(automations.update({ params: { botId, automationId }, payload: json })),
			onSuccess: written,
		}),
		remove: useMutation({
			mutationFn: ({ botId, automationId }: { botId: string; automationId: string }) =>
				Effect.runPromise(automations.remove({ params: { botId, automationId } })),
			onSuccess: refresh,
		}),
		run: useMutation({
			mutationFn: ({ botId, automationId }: { botId: string; automationId: string }) =>
				Effect.runPromise(
					automations.run({
						params: { botId, automationId },
						payload: { requestId: crypto.randomUUID() },
					}),
				),
			onSuccess: refresh,
		}),
		addTrigger: useMutation({
			mutationFn: ({
				botId,
				automationId,
				json,
			}: {
				botId: string;
				automationId: string;
				json: AutomationTriggerInput;
			}) =>
				Effect.runPromise(
					// The generated client splits a union payload into one request type
					// per member, which a request holding the whole union does not satisfy.
					automations.addTrigger({ params: { botId, automationId }, payload: json } as Parameters<
						typeof automations.addTrigger
					>[0]),
				),
			onSuccess: written,
		}),
		updateTrigger: useMutation({
			mutationFn: ({ json, ...params }: TriggerAddress & { json: AutomationTriggerInput }) =>
				Effect.runPromise(
					automations.updateTrigger({ params, payload: json } as Parameters<
						typeof automations.updateTrigger
					>[0]),
				),
			onSuccess: written,
		}),
		removeTrigger: useMutation({
			mutationFn: (params: TriggerAddress) =>
				Effect.runPromise(automations.removeTrigger({ params })),
			onSuccess: refresh,
		}),
		rotateSecret: useMutation({
			mutationFn: ({
				secret,
				...params
			}: TriggerAddress & {
				/** Null leaves the trigger without one, so its address alone runs the automation. */
				secret: string | null;
			}) => Effect.runPromise(automations.rotateSecret({ params, payload: { secret } })),
			onSuccess: ({ secret }, { triggerId }) =>
				keepSecret(triggerId, secret === null ? { kind: "none" } : { kind: "set", secret }),
		}),
	};
}
