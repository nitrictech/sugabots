import type {
	NewRoutine,
	RoutineCurrentSecret,
	RoutineTriggerInput,
	RoutineUpdate,
	RoutineWriteResult,
} from "@sugabots/contracts";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";

/** Every routine query starts with this, so one change refreshes the workspace list and each bot's. */
const ROUTINES_KEY = "routines";

export function useWorkspaceRoutines(workspaceId: string | undefined) {
	return useQuery({
		queryKey: [ROUTINES_KEY, "workspace", workspaceId],
		queryFn: workspaceId
			? ({ signal }) =>
					Effect.runPromise(
						client.api.routines.listInWorkspace({ params: { workspace: workspaceId } }),
						{ signal },
					)
			: skipToken,
	});
}

/** How many of a routine's latest runs its page shows. */
export const RECENT_RUN_COUNT = 5;

/** How often the runs are read again while one has not ended, so its status stays current. */
const RUN_POLL_MS = 3_000;

/** A routine's latest runs, newest first, read again while one is queued or running. */
export function useRecentRuns({ agentId, routineId }: { agentId: string; routineId: string }) {
	return useQuery({
		queryKey: [ROUTINES_KEY, "runs", routineId],
		queryFn: ({ signal }) =>
			Effect.runPromise(
				client.api.routines.executions({
					params: { agentId, routineId },
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

export function useRoutines(agentId: string) {
	return useQuery({
		queryKey: [ROUTINES_KEY, "agent", agentId],
		queryFn: agentId
			? ({ signal }) =>
					Effect.runPromise(client.api.routines.list({ params: { agentId } }), { signal })
			: skipToken,
	});
}

/** Webhook secrets, by trigger, kept out of `ROUTINES_KEY` so refreshing the lists doesn't read them again. */
const SECRET_KEY = "routine-secret";

/** One of a routine's triggers, through the bot the routine belongs to. */
export interface TriggerAddress {
	agentId: string;
	routineId: string;
	triggerId: string;
}

/**
 * A webhook trigger's current secret, for somebody who manages it. Nothing
 * is read for anybody else, since the API would refuse them.
 */
export function useRoutineSecret({
	canManage,
	...address
}: TriggerAddress & { canManage: boolean }) {
	return useQuery({
		queryKey: [SECRET_KEY, address.triggerId],
		queryFn: canManage
			? ({ signal }) =>
					Effect.runPromise(client.api.routines.getSecret({ params: address }), { signal })
			: skipToken,
	});
}

/** Each change names the bot its routine belongs to, since routines are addressed through their bot. */
export function useRoutineActions() {
	const queries = useQueryClient();
	const refresh = () =>
		Promise.all([
			queries.invalidateQueries({ queryKey: [ROUTINES_KEY] }),
			// A pod's chat list holds its routines, by name and how they stand.
			queries.invalidateQueries({ queryKey: ["chat-list"] }),
		]);
	const keepSecret = (triggerId: string, current: RoutineCurrentSecret) =>
		queries.setQueryData([SECRET_KEY, triggerId], current);
	const written = (result: RoutineWriteResult) => {
		for (const { triggerId, secret } of result.secrets)
			keepSecret(triggerId, { kind: "set", secret });
		// A webhook given no new secret kept the one it had, or was left without.
		const made = new Set(result.secrets.map((one) => one.triggerId));
		for (const trigger of result.routine.triggers) {
			if (trigger.kind === "webhook" && !made.has(trigger.id)) {
				void queries.invalidateQueries({ queryKey: [SECRET_KEY, trigger.id] });
			}
		}
		return refresh();
	};
	const { routines } = client.api;

	return {
		create: useMutation({
			mutationFn: ({ agentId, json }: { agentId: string; json: NewRoutine }) =>
				Effect.runPromise(routines.create({ params: { agentId }, payload: json })),
			onSuccess: written,
		}),
		update: useMutation({
			mutationFn: ({
				agentId,
				routineId,
				json,
			}: {
				agentId: string;
				routineId: string;
				json: RoutineUpdate;
			}) => Effect.runPromise(routines.update({ params: { agentId, routineId }, payload: json })),
			onSuccess: written,
		}),
		remove: useMutation({
			mutationFn: ({ agentId, routineId }: { agentId: string; routineId: string }) =>
				Effect.runPromise(routines.remove({ params: { agentId, routineId } })),
			onSuccess: refresh,
		}),
		run: useMutation({
			mutationFn: ({ agentId, routineId }: { agentId: string; routineId: string }) =>
				Effect.runPromise(
					routines.run({
						params: { agentId, routineId },
						payload: { requestId: crypto.randomUUID() },
					}),
				),
			onSuccess: refresh,
		}),
		addTrigger: useMutation({
			mutationFn: ({
				agentId,
				routineId,
				json,
			}: {
				agentId: string;
				routineId: string;
				json: RoutineTriggerInput;
			}) =>
				Effect.runPromise(
					// The generated client splits a union payload into one request type
					// per member, which a request holding the whole union does not satisfy.
					routines.addTrigger({ params: { agentId, routineId }, payload: json } as Parameters<
						typeof routines.addTrigger
					>[0]),
				),
			onSuccess: written,
		}),
		updateTrigger: useMutation({
			mutationFn: ({ json, ...params }: TriggerAddress & { json: RoutineTriggerInput }) =>
				Effect.runPromise(
					routines.updateTrigger({ params, payload: json } as Parameters<
						typeof routines.updateTrigger
					>[0]),
				),
			onSuccess: written,
		}),
		removeTrigger: useMutation({
			mutationFn: (params: TriggerAddress) => Effect.runPromise(routines.removeTrigger({ params })),
			onSuccess: refresh,
		}),
		rotateSecret: useMutation({
			mutationFn: ({
				secret,
				...params
			}: TriggerAddress & {
				/** Null leaves the trigger without one, so its address alone runs the routine. */
				secret: string | null;
			}) => Effect.runPromise(routines.rotateSecret({ params, payload: { secret } })),
			onSuccess: ({ secret }, { triggerId }) =>
				keepSecret(triggerId, secret === null ? { kind: "none" } : { kind: "set", secret }),
		}),
	};
}
