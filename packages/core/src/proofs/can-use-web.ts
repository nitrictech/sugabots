import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { WebToolOff } from "@sugabots/contracts/errors/web";
import type { WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from "@sugabots/contracts/operations/web";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { query } from "../database/database.ts";
import { bot } from "../database/schema.ts";
import type { BotPrincipal } from "../principal.ts";
import { SearchProviderStore } from "../providers/search-providers/search-provider-store.ts";
import { type InWorkspace, proveInWorkspace } from "./in-workspace.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";

type WebTool = typeof WEB_FETCH_TOOL | typeof WEB_SEARCH_TOOL;

export interface CanUseWeb<P, W, Tool extends WebTool> extends Proof<"CanUseWeb", [P, W]> {
	readonly inWorkspace: InWorkspace<P, W>;
	readonly tool: Tool;
}

const CanUseWebProof = defineProof("CanUseWeb");

export const proveCanUseWeb = <P, W, Tool extends WebTool>(
	principal: Named<P, BotPrincipal>,
	workspace: Named<W, string>,
	tool: Tool,
) =>
	Effect.gen(function* () {
		const inWorkspace = yield* proveInWorkspace(principal, workspace);
		const [settings] = yield* query((db) =>
			db
				.select({ disabledTools: bot.disabledTools })
				.from(bot)
				.where(and(eq(bot.id, principal.value.bot), eq(bot.workspaceId, workspace.value)))
				.limit(1),
		);
		if (!settings) return yield* new ResourceHidden({ resource: "bot" });
		const providers = yield* SearchProviderStore.Service;
		if (settings.disabledTools.includes(tool) || !(yield* providers.resolve(workspace.value))) {
			return yield* new WebToolOff();
		}
		const proof: CanUseWeb<P, W, Tool> = CanUseWebProof.prove([principal, workspace], {
			inWorkspace,
			tool,
		});
		return proof;
	});
