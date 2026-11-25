import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { Effect } from "effect";
import type { Principal, StoredWork } from "../principal.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";

type ScheduledWork = Exclude<StoredWork, { kind: "compaction" }>;
type Kind = ScheduledWork["kind"];

export interface DoesStoredWork<P, I, K extends Kind> extends Proof<"DoesStoredWork", [P, I]> {
	readonly id: Named<I, string>;
	readonly workspace: string;
	readonly work: Extract<ScheduledWork, { kind: K }>;
}

const DoesStoredWorkProof = defineProof("DoesStoredWork");

const resource = {
	dueRoutine: "automation",
	pauseAfterFailures: "automation",
	computerSleep: "computer",
	approvalExpiry: "approval",
	gitHubUninstall: "connector",
	deletion: "workspace",
} as const;

function namesWork<K extends Kind>(
	work: StoredWork,
	kind: K,
	id: string,
): work is Extract<ScheduledWork, { kind: K }> {
	if (work.kind !== kind) return false;
	switch (work.kind) {
		case "dueRoutine":
			return work.trigger === id;
		case "pauseAfterFailures":
			return work.automation === id;
		case "computerSleep":
			return work.computer === id;
		case "approvalExpiry":
			return work.approval === id;
		case "gitHubUninstall":
			return work.uninstall === id;
		case "deletion":
			return work.id === id;
	}
	return false;
}

export function proveDoesStoredWork<P, I, K extends Kind>(
	principal: Named<P, Principal>,
	id: Named<I, string>,
	kind: K,
): Effect.Effect<DoesStoredWork<P, I, K>, ResourceHidden> {
	const acting = principal.value;
	if (acting._tag !== "SystemWork" || !namesWork(acting.work, kind, id.value)) {
		return Effect.fail(new ResourceHidden({ resource: resource[kind] }));
	}
	return Effect.succeed(
		DoesStoredWorkProof.prove([principal, id], {
			id,
			workspace: acting.workspace,
			work: acting.work,
		}),
	);
}
