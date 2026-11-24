import { type ConnectorAccess, connectorToolWritesOrDeletes } from "@sugabots/contracts";
import { ActionForbidden, BotCannotReach, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { query } from "../database/database.ts";
import { connector } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import type { Principal } from "../principal.ts";
import { toolAccessOf } from "../providers/connectors/tool-access.ts";
import { decideReach, mayInProjectAs, memberReaches, reachFacts, whoActs } from "./facts.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";

/**
 * P may call the tool `tool` of the connector K: one of the project within
 * P's bounds, or of the bot itself, whose default project a bot's asker must
 * reach too. A write/delete tool needs a principal that may change things
 * there, so not a viewer or a viewer's bot. A GitHub app's webhook call uses
 * only its own connector.
 *
 * Whether the tool's access lets the call run is `Approved`'s to decide; the
 * proof carries that access as it stands.
 */
export interface CanUseConnector<P, K> extends Proof<"CanUseConnector", [P, K]> {
	readonly principal: Named<P, Principal>;
	readonly connector: Named<K, string>;
	/** K's workspace and project, which services take from here. */
	readonly workspace: string;
	readonly project: string;
	readonly tool: string;
	readonly writeOrDelete: boolean;
	readonly access: ConnectorAccess;
}

const CanUseConnectorProof = defineProof("CanUseConnector");

export const proveCanUseConnector = <P, K>(
	principal: Named<P, Principal>,
	connectorId: Named<K, string>,
	tool: string,
) =>
	Effect.gen(function* () {
		const hidden = new ResourceHidden({ resource: "connector" });
		const acting = principal.value;
		const id = connectorId.value;
		const [row] = isUuid(id)
			? yield* query((db) =>
					db
						.select({
							workspace: connector.workspaceId,
							project: connector.projectId,
							tools: connector.tools,
							toolAccess: connector.toolAccess,
						})
						.from(connector)
						.where(eq(connector.id, id))
						.limit(1),
				)
			: [];
		if (!row) return yield* Effect.fail(hidden);
		const described = row.tools.find((listed) => listed.name === tool) ?? {
			name: tool,
			description: null,
			readOnly: null,
			destructive: null,
		};
		const writeOrDelete = connectorToolWritesOrDeletes(described);
		const proof = () => {
			const made: CanUseConnector<P, K> = CanUseConnectorProof.prove([principal, connectorId], {
				principal,
				connector: connectorId,
				workspace: row.workspace,
				project: row.project,
				tool,
				writeOrDelete,
				access: toolAccessOf(row.toolAccess, described),
			});
			return made;
		};

		if (acting._tag === "WebhookCall") {
			const signedByIt = acting.source.kind === "github" && acting.source.connector === id;
			return signedByIt ? proof() : yield* Effect.fail(hidden);
		}
		const facts = yield* query((db) => reachFacts(db, row.project, whoActs(acting)));
		if (!facts) return yield* Effect.fail(hidden);
		const botsOwn =
			(acting._tag === "BotForAsker" || acting._tag === "AutomationRun") &&
			acting.workspace === facts.project.workspace &&
			facts.project.defaultOf?.id === acting.bot;
		if (botsOwn) {
			if (acting._tag === "BotForAsker" && !memberReaches(facts.member, facts.project)) {
				return yield* Effect.fail(hidden);
			}
		} else {
			const decision = decideReach(acting, facts, undefined);
			if (decision.kind === "hidden") return yield* Effect.fail(hidden);
			if (decision.kind === "botCannotReach") {
				return yield* Effect.fail(new BotCannotReach({ resource: "connector" }));
			}
			if (decision.as.kind === "webhook" || decision.as.kind === "systemWork") {
				return yield* Effect.fail(new ActionForbidden({ proof: "CanUseConnector" }));
			}
		}
		const member =
			acting._tag === "MemberSession" || acting._tag === "BotForAsker" ? facts.member : undefined;
		const mayWrite =
			acting._tag === "AutomationRun" ||
			(member !== undefined && mayInProjectAs(member, facts.project, "project.change"));
		if (writeOrDelete && !mayWrite) {
			return yield* Effect.fail(new ActionForbidden({ proof: "CanUseConnector" }));
		}
		return proof();
	});
