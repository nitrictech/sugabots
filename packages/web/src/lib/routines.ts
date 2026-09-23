import type { NewRoutine, RoutineUpdate } from "@sugabots/contracts";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";

export function useRoutines(agentId: string) {
	return useQuery({
		queryKey: ["routines", agentId],
		queryFn: agentId
			? ({ signal }) =>
					Effect.runPromise(client.api.routines.list({ params: { agentId } }), { signal })
			: skipToken,
	});
}

export function useRoutineExecutions(agentId: string, routineId: string) {
	return useQuery({
		queryKey: ["routine-executions", agentId, routineId],
		queryFn: ({ signal }) =>
			Effect.runPromise(
				client.api.routines.executions({ params: { agentId, routineId }, query: { limit: 5 } }),
				{ signal },
			),
		refetchInterval: (query) =>
			query.state.data?.items.some((execution) => ["queued", "running"].includes(execution.state))
				? 1_000
				: false,
	});
}

export function useRoutineActions(agentId: string) {
	const queries = useQueryClient();
	const refresh = () => queries.invalidateQueries({ queryKey: ["routines", agentId] });
	const refreshExecutions = (routineId: string) =>
		queries.invalidateQueries({ queryKey: ["routine-executions", agentId, routineId] });
	const { routines } = client.api;

	return {
		create: useMutation({
			mutationFn: (json: NewRoutine) =>
				Effect.runPromise(
					// The generated client splits a union payload into one request type
					// per member, which a request holding the whole union does not satisfy.
					routines.create({ params: { agentId }, payload: json } as Parameters<
						typeof routines.create
					>[0]),
				),
			onSuccess: refresh,
		}),
		update: useMutation({
			mutationFn: ({ routineId, json }: { routineId: string; json: RoutineUpdate }) =>
				Effect.runPromise(routines.update({ params: { agentId, routineId }, payload: json })),
			onSuccess: refresh,
		}),
		remove: useMutation({
			mutationFn: (routineId: string) =>
				Effect.runPromise(routines.remove({ params: { agentId, routineId } })),
			onSuccess: refresh,
		}),
		run: useMutation({
			mutationFn: (routineId: string) =>
				Effect.runPromise(
					routines.run({
						params: { agentId, routineId },
						payload: { requestId: crypto.randomUUID() },
					}),
				),
			onSuccess: (_result, routineId) => void refreshExecutions(routineId),
		}),
		rotateSecret: useMutation({
			mutationFn: (routineId: string) =>
				Effect.runPromise(routines.rotateSecret({ params: { agentId, routineId } })),
		}),
		preview: useMutation({
			mutationFn: (json: { expression: string; timezone: string }) =>
				Effect.runPromise(routines.previewSchedule({ params: { agentId }, payload: json })),
		}),
	};
}
