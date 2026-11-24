/**
 * How a principal meets a bot, before any bot permission is decided: whether
 * the bot is within a bot principal's bounds, and the member, if any, whose
 * role and reach decide the rest. Shared by the bot provers; it makes no proof.
 */

import { Effect } from "effect";
import type { Actor } from "../authorization/permissions.ts";
import { type Database, query } from "../database/database.ts";
import type { Principal } from "../principal.ts";
import { actorOf, type BotRecord, projectHasBot, roleIn } from "./facts.ts";

/**
 * The bot as `principal` meets it.
 *
 * - `member`: the member whose role decides, a member signed in or a bot's
 *   asker, and whether a bot principal's bounds hold the bot.
 * - `run`: a run, and whether its bounds hold the bot.
 * - `none`: a principal that reaches no bot, or one outside its workspace.
 */
export type BotAsMet =
	| {
			readonly kind: "member";
			readonly actor: Actor;
			readonly withinBounds: boolean;
			/** Whether a bot principal is in member bounds, or in the bot's own chats. */
			readonly mayManage: "always" | "ownChats" | "never";
	  }
	| { readonly kind: "run"; readonly withinBounds: boolean }
	| { readonly kind: "none" };

export const meetBot = (principal: Principal, bot: BotRecord) =>
	Effect.gen(function* (): Effect.fn.Return<BotAsMet, never, Database> {
		switch (principal._tag) {
			case "MemberSession": {
				const role = yield* query((db) => roleIn(db, bot.workspace, principal.member));
				return {
					kind: "member",
					actor: actorOf(principal.member, role),
					withinBounds: true,
					mayManage: "always",
				};
			}
			case "BotForAsker": {
				if (principal.workspace !== bot.workspace) return { kind: "none" };
				const role = yield* query((db) => roleIn(db, bot.workspace, principal.asker));
				const actor = actorOf(principal.asker, role);
				if (principal.bounds.kind === "member") {
					return { kind: "member", actor, withinBounds: true, mayManage: "always" };
				}
				const { project } = principal.bounds;
				const own = bot.id === principal.bot;
				const withinBounds = own || (yield* query((db) => projectHasBot(db, project, bot.id)));
				const inOwnChats = own && bot.defaultProject === project;
				return {
					kind: "member",
					actor,
					withinBounds,
					mayManage: inOwnChats ? "ownChats" : "never",
				};
			}
			case "AutomationRun": {
				if (principal.workspace !== bot.workspace) return { kind: "none" };
				const { project } = principal.bounds;
				const withinBounds =
					bot.id === principal.bot || (yield* query((db) => projectHasBot(db, project, bot.id)));
				return { kind: "run", withinBounds };
			}
			default:
				return { kind: "none" };
		}
	});
