import { ActionForbidden, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import type { Actor } from "../authorization/permissions.ts";
import { type Database, query } from "../database/database.ts";
import { project } from "../database/schema.ts";
import { isUuid } from "../ids/ids.ts";
import type { Principal } from "../principal.ts";
import {
	administers,
	type BotRecord,
	botAtAdmission,
	botRecord,
	memberReachesBot,
	restrictsBot,
	whoActs,
} from "./facts.ts";
import { meetBot } from "./meet-bot.ts";
import { defineProof, type Named, type Proof } from "./proof.ts";

/**
 * P is an admin of the bot B's workspace, and so may delete B or switch off
 * its automations and connectors without reaching it, as admins may a
 * personal bot, a Personal Assistant included. A system bot can't be
 * restricted. A bot acting for its asker gets it only in
 * member bounds; a run never does.
 */
export interface CanRestrictBot<P, B> extends Proof<"CanRestrictBot", [P, B]> {
	readonly principal: Named<P, Principal>;
	readonly bot: Named<B, string>;
	/** B's workspace, which services take from here. */
	readonly workspace: string;
	readonly facts: BotRecord;
	/** The admin: a member signed in, or a bot's asker in member bounds. */
	readonly actor: Actor;
}

/**
 * The project J is the default project of a bot P may restrict (see
 * {@link CanRestrictBot}): P may read how J's automations and connectors are
 * set up, and switch them off, without reaching J or its chats.
 */
export interface CanRestrictBotsProject<P, J> extends Proof<"CanRestrictBotsProject", [P, J]> {
	readonly principal: Named<P, Principal>;
	readonly project: Named<J, string>;
	/** J's workspace, which services take from here. */
	readonly workspace: string;
	/** The bot whose default project J is. */
	readonly bot: BotRecord;
	/** The admin: a member signed in, or a bot's asker in member bounds. */
	readonly actor: Actor;
}

const CanRestrictBotProof = defineProof("CanRestrictBot");
const CanRestrictBotsProjectProof = defineProof("CanRestrictBotsProject");

/**
 * The admin who may restrict `record`, as `principal` meets it, or the
 * refusal: hidden where they don't see the bot, forbidden where they do.
 */
const restrictingAdmin = (
	principal: Principal,
	record: BotRecord,
	refused: string,
): Effect.Effect<Actor, ResourceHidden | ActionForbidden, Database> =>
	Effect.gen(function* () {
		const hidden = new ResourceHidden({ resource: "bot" });
		const forbidden = new ActionForbidden({ proof: refused });
		const met = yield* meetBot(principal, record);
		if (met.kind === "none") return yield* Effect.fail(hidden);
		if (met.kind === "run") return yield* Effect.fail(forbidden);
		const { actor } = met;
		// Admins see every bot, without reaching it.
		const seen = memberReachesBot(actor, botAtAdmission(principal, record)) || administers(actor);
		if (!seen) return yield* Effect.fail(hidden);
		if (!restrictsBot(actor, record) || met.mayManage !== "always") {
			return yield* Effect.fail(forbidden);
		}
		return actor;
	});

export const proveCanRestrictBot = <P, B>(
	principal: Named<P, Principal>,
	botId: Named<B, string>,
) =>
	Effect.gen(function* () {
		const record = yield* query((db) => botRecord(db, botId.value, whoActs(principal.value)));
		if (!record) return yield* Effect.fail(new ResourceHidden({ resource: "bot" }));
		const actor = yield* restrictingAdmin(principal.value, record, "CanRestrictBot");
		const proof: CanRestrictBot<P, B> = CanRestrictBotProof.prove([principal, botId], {
			principal,
			bot: botId,
			workspace: record.workspace,
			facts: record,
			actor,
		});
		return proof;
	});

export const proveCanRestrictBotsProject = <P, J>(
	principal: Named<P, Principal>,
	projectId: Named<J, string>,
) =>
	Effect.gen(function* () {
		const hidden = new ResourceHidden({ resource: "project" });
		const id = projectId.value;
		const [found] = isUuid(id)
			? yield* query((db) =>
					db
						.select({ bot: project.defaultOfBotId })
						.from(project)
						.where(eq(project.id, id))
						.limit(1),
				)
			: [];
		const defaultOf = found?.bot;
		const record = defaultOf
			? yield* query((db) => botRecord(db, defaultOf, whoActs(principal.value)))
			: undefined;
		if (!record) return yield* Effect.fail(hidden);
		// Whoever doesn't see the bot doesn't learn its project is a bot's.
		const actor = yield* restrictingAdmin(principal.value, record, "CanRestrictBotsProject").pipe(
			Effect.mapError((refusal) => (refusal._tag === "ResourceHidden" ? hidden : refusal)),
		);
		const proof: CanRestrictBotsProject<P, J> = CanRestrictBotsProjectProof.prove(
			[principal, projectId],
			{ principal, project: projectId, workspace: record.workspace, bot: record, actor },
		);
		return proof;
	});
