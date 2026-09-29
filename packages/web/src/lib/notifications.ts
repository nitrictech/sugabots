import type {
	NotificationPreferences,
	UpdateNotificationDelivery,
	UpdateNotificationPreference,
} from "@sugabots/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";

/** A person's preferences are theirs in every workspace, so the key names none. */
const preferencesKey = ["notificationPreferences"];

/** What the signed-in person hears about, and how. */
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
	return useOptimisticPreferences(
		(payload: UpdateNotificationPreference) =>
			Effect.runPromise(client.api.notifications.updatePreference({ payload })),
		(before, { kind, enabled }) => ({ ...before, kinds: { ...before.kinds, [kind]: enabled } }),
	);
}

/**
 * Saves how the person is told. The control moves before the API answers and
 * moves back if the save fails.
 */
export function useUpdateNotificationDelivery() {
	return useOptimisticPreferences(
		(payload: UpdateNotificationDelivery) =>
			Effect.runPromise(client.api.notifications.updateDelivery({ payload })),
		(before, change) => ({ ...before, delivery: { ...before.delivery, ...change } }),
	);
}

/** A save of the preferences shown as `expected` straight away, and put back if it fails. */
function useOptimisticPreferences<Payload>(
	save: (payload: Payload) => Promise<NotificationPreferences>,
	expected: (before: NotificationPreferences, payload: Payload) => NotificationPreferences,
) {
	const queries = useQueryClient();
	return useMutation({
		mutationFn: save,
		onMutate: async (payload) => {
			await queries.cancelQueries({ queryKey: preferencesKey });
			const before = queries.getQueryData<NotificationPreferences>(preferencesKey);
			if (before) queries.setQueryData(preferencesKey, expected(before, payload));
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
