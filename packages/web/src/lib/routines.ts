import type {
	NewRoutine,
	RoutineCurrentSecret,
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

/** Webhook secrets, by routine, kept out of `ROUTINES_KEY` so refreshing the lists doesn't read them again. */
const SECRET_KEY = "routine-secret";

/**
 * A webhook routine's current secret, for somebody who manages it. Nothing
 * is read for anybody else, since the API would refuse them.
 */
export function useRoutineSecret({
	agentId,
	routineId,
	canManage,
}: {
	agentId: string;
	routineId: string;
	canManage: boolean;
}) {
	return useQuery({
		queryKey: [SECRET_KEY, routineId],
		queryFn: canManage
			? ({ signal }) =>
					Effect.runPromise(client.api.routines.getSecret({ params: { agentId, routineId } }), {
						signal,
					})
			: skipToken,
	});
}

/** Each change names the bot its routine belongs to, since routines are addressed through their bot. */
export function useRoutineActions() {
	const queries = useQueryClient();
	const refresh = () => queries.invalidateQueries({ queryKey: [ROUTINES_KEY] });
	const keepSecret = (routineId: string, current: RoutineCurrentSecret) =>
		queries.setQueryData([SECRET_KEY, routineId], current);
	const written = (result: RoutineWriteResult) => {
		// A write that returns no secret kept the one it had, or was left without.
		if (result.secret) keepSecret(result.routine.id, { kind: "set", secret: result.secret });
		else void queries.invalidateQueries({ queryKey: [SECRET_KEY, result.routine.id] });
		return refresh();
	};
	const { routines } = client.api;

	return {
		create: useMutation({
			mutationFn: ({ agentId, json }: { agentId: string; json: NewRoutine }) =>
				Effect.runPromise(
					// The generated client splits a union payload into one request type
					// per member, which a request holding the whole union does not satisfy.
					routines.create({ params: { agentId }, payload: json } as Parameters<
						typeof routines.create
					>[0]),
				),
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
		rotateSecret: useMutation({
			mutationFn: ({
				agentId,
				routineId,
				secret,
			}: {
				agentId: string;
				routineId: string;
				/** Null leaves the routine without one, so its address alone runs it. */
				secret: string | null;
			}) =>
				Effect.runPromise(
					routines.rotateSecret({ params: { agentId, routineId }, payload: { secret } }),
				),
			onSuccess: ({ secret }, { routineId }) =>
				keepSecret(routineId, secret === null ? { kind: "none" } : { kind: "set", secret }),
		}),
	};
}
