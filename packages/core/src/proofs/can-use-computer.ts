import { ActionForbidden, BotCannotReach, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { query } from "../database/database.ts";
import { computer } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import type { Principal } from "../principal.ts";
import { decideReach, mayInProjectAs, reachFacts, whoActs } from "./facts.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";

/**
 * How a member uses a computer's desktop: watching it, or taking it over to
 * click and type. A bot always works on it.
 */
export type ComputerUse = "watch" | "control";

/**
 * P may use the online computer M. A bot: the computer of the project within
 * its bounds, with its computer use on and, acting for its asker, an asker who
 * may change things there. A member: watching needs reach, and taking over
 * needs `computer.desktop.use` there. System work reaches only the computer it
 * puts to sleep.
 */
export interface CanUseComputer<P, M> extends Proof<"CanUseComputer", [P, M]> {
	readonly principal: Named<P, Principal>;
	readonly computer: Named<M, string>;
	/** M's workspace and project, which services take from here. */
	readonly workspace: string;
	readonly project: string;
	readonly control: boolean;
}

const CanUseComputerProof = defineProof("CanUseComputer");

export const proveCanUseComputer = <P, M>(
	principal: Named<P, Principal>,
	computerId: Named<M, string>,
	use: ComputerUse,
) =>
	Effect.gen(function* () {
		const hidden = new ResourceHidden({ resource: "computer" });
		const forbidden = new ActionForbidden({ proof: "CanUseComputer" });
		const acting = principal.value;
		const id = computerId.value;
		const [row] = isUuid(id)
			? yield* query((db) =>
					db
						.select({ workspace: computer.workspaceId, project: computer.projectId })
						.from(computer)
						.where(eq(computer.id, id))
						.limit(1),
				)
			: [];
		if (!row) return yield* Effect.fail(hidden);
		const proof = (control: boolean) => {
			const made: CanUseComputer<P, M> = CanUseComputerProof.prove([principal, computerId], {
				principal,
				computer: computerId,
				workspace: row.workspace,
				project: row.project,
				control,
			});
			return made;
		};

		if (acting._tag === "SystemWork") {
			const putsItToSleep =
				acting.workspace === row.workspace &&
				acting.work.kind === "computerSleep" &&
				acting.work.computer === id;
			return putsItToSleep ? proof(true) : yield* Effect.fail(hidden);
		}
		const facts = yield* query((db) => reachFacts(db, row.project, whoActs(acting)));
		if (!facts) return yield* Effect.fail(hidden);
		const decision = decideReach(acting, facts, undefined);
		if (decision.kind === "hidden") return yield* Effect.fail(hidden);
		if (decision.kind === "botCannotReach") {
			return yield* Effect.fail(new BotCannotReach({ resource: "computer" }));
		}
		const { as } = decision;
		switch (as.kind) {
			case "member": {
				const mayControl = mayInProjectAs(as.place, facts.project, "computer.desktop.use");
				if (use === "control" && !mayControl) return yield* Effect.fail(forbidden);
				return proof(use === "control");
			}
			case "asker":
				if (
					!facts.bot?.usesComputer ||
					!mayInProjectAs(as.place, facts.project, "project.change")
				) {
					return yield* Effect.fail(forbidden);
				}
				return proof(true);
			case "run":
				return facts.bot?.usesComputer ? proof(true) : yield* Effect.fail(forbidden);
			default:
				return yield* Effect.fail(forbidden);
		}
	});
