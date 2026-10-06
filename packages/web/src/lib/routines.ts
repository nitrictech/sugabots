import type { NewRoutine, RoutineUpdate } from "@sugabots/contracts";
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

export function useRoutines(agentId: string) {
	return useQuery({
		queryKey: [ROUTINES_KEY, "agent", agentId],
		queryFn: agentId
			? ({ signal }) =>
					Effect.runPromise(client.api.routines.list({ params: { agentId } }), { signal })
			: skipToken,
	});
}

/** Each change names the bot its routine belongs to, since routines are addressed through their bot. */
export function useRoutineActions() {
	const queries = useQueryClient();
	const refresh = () => queries.invalidateQueries({ queryKey: [ROUTINES_KEY] });
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
			onSuccess: refresh,
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
			onSuccess: refresh,
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
		}),
		rotateSecret: useMutation({
			mutationFn: ({ agentId, routineId }: { agentId: string; routineId: string }) =>
				Effect.runPromise(routines.rotateSecret({ params: { agentId, routineId } })),
		}),
	};
}
