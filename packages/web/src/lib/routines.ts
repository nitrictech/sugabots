import type { NewRoutine, RoutineUpdate } from "@sugabots/contracts";
import { unwrap, unwrapEmpty } from "@sugabots/sdk";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client } from "@/api.ts";

export function useRoutines(agentId: string) {
	return useQuery({
		queryKey: ["routines", agentId],
		queryFn: agentId
			? () => unwrap(client.api.agents[":agentId"].routines.$get({ param: { agentId } }))
			: skipToken,
	});
}

export function useRoutineExecutions(agentId: string, routineId: string) {
	return useQuery({
		queryKey: ["routine-executions", agentId, routineId],
		queryFn: () =>
			unwrap(
				client.api.agents[":agentId"].routines[":routineId"].executions.$get({
					param: { agentId, routineId },
					query: { limit: "5" },
				}),
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
	const route = () => client.api.agents[":agentId"].routines;

	return {
		create: useMutation({
			mutationFn: (json: NewRoutine) => unwrap(route().$post({ param: { agentId }, json })),
			onSuccess: refresh,
		}),
		update: useMutation({
			mutationFn: ({ routineId, json }: { routineId: string; json: RoutineUpdate }) =>
				unwrap(route()[":routineId"].$patch({ param: { agentId, routineId }, json })),
			onSuccess: refresh,
		}),
		remove: useMutation({
			mutationFn: (routineId: string) =>
				unwrapEmpty(route()[":routineId"].$delete({ param: { agentId, routineId } })),
			onSuccess: refresh,
		}),
		run: useMutation({
			mutationFn: (routineId: string) =>
				unwrap(
					route()[":routineId"].run.$post({
						param: { agentId, routineId },
						json: { requestId: crypto.randomUUID() },
					}),
				),
			onSuccess: (_result, routineId) => void refreshExecutions(routineId),
		}),
		rotateSecret: useMutation({
			mutationFn: (routineId: string) =>
				unwrap(route()[":routineId"].secret.$post({ param: { agentId, routineId } })),
		}),
		preview: useMutation({
			mutationFn: (json: { expression: string; timezone: string }) =>
				unwrap(route()["schedule-preview"].$post({ param: { agentId }, json })),
		}),
	};
}
