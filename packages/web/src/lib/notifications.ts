import type { NotificationPreferences, UpdateNotificationPreference } from "@sugabots/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";

/** A person's preferences are theirs in every workspace, so the key names none. */
const preferencesKey = ["notificationPreferences"];

/** Whether the signed-in person hears about each kind of notification. */
export function useNotificationPreferences() {
	return useQuery({
		queryKey: preferencesKey,
		queryFn: ({ signal }) => Effect.runPromise(client.api.notifications.preferences(), { signal }),
	});
}

/**
 * Saves whether the person hears about one kind. The switch moves before the
 * API answers and moves back if the save fails.
 */
export function useUpdateNotificationPreference() {
	const queries = useQueryClient();
	return useMutation({
		mutationFn: (payload: UpdateNotificationPreference) =>
			Effect.runPromise(client.api.notifications.updatePreference({ payload })),
		onMutate: async ({ kind, enabled }) => {
			await queries.cancelQueries({ queryKey: preferencesKey });
			const before = queries.getQueryData<NotificationPreferences>(preferencesKey);
			if (before) queries.setQueryData(preferencesKey, { ...before, [kind]: enabled });
			return { before };
		},
		onError: (_error, _payload, context) => {
			if (context?.before) queries.setQueryData(preferencesKey, context.before);
		},
		onSuccess: (preferences) => {
			queries.setQueryData(preferencesKey, preferences);
		},
	});
}
