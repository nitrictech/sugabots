import { type Agent, DESKTOP_DEVICE_GLOBAL, type LocalAgentKind } from "@sugabots/contracts";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { useSyncExternalStore } from "react";
import { client } from "@/api.ts";
import { isOffline } from "@/lib/agents.ts";

/**
 * Which of the signed-in person's devices this page is running on: the id
 * the Sugabots desktop app sets on its window, or null in a plain browser
 * or before the app has connected. Lending is offered only there, and only
 * for that computer; the server and the computer still decide who may.
 */
export function useThisDevice(): string | null {
	return useSyncExternalStore(subscribeToThisDevice, readThisDevice, () => null);
}

function subscribeToThisDevice(onChange: () => void) {
	window.addEventListener(DESKTOP_DEVICE_GLOBAL, onChange);
	return () => window.removeEventListener(DESKTOP_DEVICE_GLOBAL, onChange);
}

function readThisDevice(): string | null {
	const deviceId: unknown = Reflect.get(window, DESKTOP_DEVICE_GLOBAL);
	return typeof deviceId === "string" ? deviceId : null;
}

/** Sets which device this page is on, as the desktop app does, for stories and tests. */
export function setThisDevice(deviceId: string | null) {
	Reflect.set(window, DESKTOP_DEVICE_GLOBAL, deviceId);
	window.dispatchEvent(new Event(DESKTOP_DEVICE_GLOBAL));
}

/**
 * The signed-in person's computers running the desktop app, each with the
 * agents it lends while it's connected. Refetched now and then, since a
 * device comes and goes without the web app hearing about it.
 */
export const devicesQuery = queryOptions({
	queryKey: ["devices"],
	queryFn: ({ signal }) => Effect.runPromise(client.api.devices.list(), { signal }),
	refetchInterval: 15_000,
});

export function useDevices(enabled = true) {
	return useQuery({ ...devicesQuery, enabled });
}

/** Unpairs one of the signed-in person's devices. */
export function useForgetDevice() {
	const queries = useQueryClient();
	return useMutation({
		mutationFn: (deviceId: string) =>
			Effect.runPromise(client.api.devices.forget({ params: { deviceId } })),
		onSettled: () => queries.invalidateQueries({ queryKey: devicesQuery.queryKey }),
	});
}

/**
 * Asks one of the signed-in person's computers to lend an agent of `kind`.
 * The folder is chosen on that computer, by its owner, so this waits on them
 * and fails with `Conflict` when they decline there.
 */
export function useLendAgent() {
	const queries = useQueryClient();
	return useMutation({
		mutationFn: ({ deviceId, kind }: { deviceId: string; kind: LocalAgentKind }) =>
			Effect.runPromise(client.api.devices.lend({ params: { deviceId }, payload: { kind } })),
		onSettled: () => queries.invalidateQueries({ queryKey: devicesQuery.queryKey }),
	});
}

/** Stops one of the signed-in person's computers lending the agent at `url`. */
export function useStopLending() {
	const queries = useQueryClient();
	return useMutation({
		mutationFn: ({ deviceId, url }: { deviceId: string; url: string }) =>
			Effect.runPromise(client.api.devices.stopLending({ params: { deviceId }, payload: { url } })),
		onSettled: () => queries.invalidateQueries({ queryKey: devicesQuery.queryKey }),
	});
}

/** The pairing a desktop is waiting on, under the code it opened this page with. */
export function usePendingPairing(code: string) {
	return useQuery({
		queryKey: ["devicePairing", code],
		queryFn: ({ signal }) =>
			Effect.runPromise(client.api.devices.pendingPairing({ params: { code } }), { signal }),
		retry: false,
	});
}

/** Pairs the desktop waiting under `code` to the signed-in person. */
export function useApprovePairing(code: string) {
	const queries = useQueryClient();
	return useMutation({
		mutationFn: () => Effect.runPromise(client.api.devices.approvePairing({ params: { code } })),
		onSuccess: () => queries.invalidateQueries({ queryKey: devicesQuery.queryKey }),
	});
}

/**
 * Why `agent` can't answer, when it stands for an agent on a computer that
 * isn't connected: the computer by name to its owner, who can see their
 * devices, and in general to everyone else. Nothing while it can answer.
 */
export function useOfflineReason(agent: Pick<Agent, "a2a">): string | undefined {
	const offline = isOffline(agent);
	const devices = useDevices(offline);
	if (!offline) return undefined;
	const device = devices.data?.find(({ id }) => id === agent.a2a?.deviceId);
	return device ? `${device.name} isn't connected` : "the computer it runs on isn't connected";
}
