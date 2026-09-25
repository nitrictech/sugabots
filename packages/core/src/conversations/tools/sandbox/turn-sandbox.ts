import type { RunEffect } from "../../../database/database.ts";
import type { Sandbox } from "../../../sandboxes/sandbox.ts";
import {
	LEASE_RENEWAL_INTERVAL_SECONDS,
	type LeasedSandbox,
	type LeaseScope,
	type PodSandboxStore,
} from "../../../sandboxes/store.ts";

/**
 * One turn's hold on its pod's sandbox.
 *
 * The lease is taken on the turn's first sandbox tool call rather than when
 * the turn starts, so a turn that never touches the sandbox never wakes it.
 * It is renewed while the turn runs, and released when the turn's scope ends:
 * finished, failed, or parked waiting for an approval.
 */
export interface TurnSandbox {
	/** The sandbox, leased on first use. Rejects with the store's error when it can't be had. */
	sandbox(): Promise<Sandbox.Handle>;
	release(): Promise<void>;
}

export function turnSandbox(
	store: PodSandboxStore,
	scope: LeaseScope,
	run: RunEffect,
): TurnSandbox {
	let leased: Promise<LeasedSandbox> | undefined;
	let renewal: ReturnType<typeof setInterval> | undefined;

	const lease = async () => {
		const held = await run(store.lease(scope));
		renewal = setInterval(() => {
			run(store.renew(held.leaseId)).catch(() => {});
		}, LEASE_RENEWAL_INTERVAL_SECONDS * 1_000);
		return held;
	};

	return {
		sandbox: async () => {
			leased ??= lease().catch((failure) => {
				// Not remembered: the next call tries again, since a provider that
				// was unreachable a moment ago may not be now.
				leased = undefined;
				throw failure;
			});
			return (await leased).sandbox;
		},
		release: async () => {
			clearInterval(renewal);
			const held = await leased?.catch(() => undefined);
			if (!held) return;
			await run(held.sandbox.disconnect);
			await run(store.release(held.leaseId));
		},
	};
}
