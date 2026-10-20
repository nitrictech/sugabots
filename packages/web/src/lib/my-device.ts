import type { DeviceLending } from "@sugabots/contracts/devices";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiBaseUrl } from "@/lib/api-url.ts";

/** How often to look for the person's desktop app connecting or going away. */
const DEVICE_POLL_MS = 10_000;

const myDeviceKey = (threadId: string) => ["my-device", threadId] as const;

async function requestMyDevice(threadId: string, init?: RequestInit): Promise<DeviceLending> {
	const response = await fetch(`${apiBaseUrl}/threads/${threadId}/my-device`, {
		credentials: "include",
		...init,
	});
	if (!response.ok) throw new Error(`Couldn't read your desktop's state (${response.status})`);
	return (await response.json()) as DeviceLending;
}

/** Whether the person's desktop app is connected, and lent to the thread. */
export function useMyDevice(threadId: string | undefined) {
	return useQuery({
		queryKey: myDeviceKey(threadId ?? ""),
		queryFn: () => requestMyDevice(threadId ?? ""),
		enabled: threadId !== undefined,
		refetchInterval: DEVICE_POLL_MS,
	});
}

export function useLendMyDevice(threadId: string) {
	const queries = useQueryClient();
	return useMutation({
		mutationFn: (lent: boolean) =>
			requestMyDevice(threadId, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ lent }),
			}),
		onSuccess: (lending) => queries.setQueryData(myDeviceKey(threadId), lending),
	});
}
