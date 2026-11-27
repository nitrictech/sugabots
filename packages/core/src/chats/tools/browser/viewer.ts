export * as DesktopViewer from "./viewer.ts";

import type { BotColor } from "@sugabots/contracts";
import { DesktopUnavailable } from "@sugabots/contracts/errors/computers";
import { userText } from "@sugabots/errors";
import { and, eq } from "drizzle-orm";
import { Context, Effect, Layer, type Scope } from "effect";
import { ComputerProviderStore } from "../../../computers/computer-provider-store.ts";
import type { Computers } from "../../../computers/computers.ts";
import { ProjectComputers } from "../../../computers/project-computers.ts";
import { query, serviceOperations } from "../../../database/database.ts";
import {
	bot as botTable,
	chatParticipant,
	computer as computerTable,
	projectBot,
} from "../../../database/schema.ts";
import { Ids } from "../../../ids/ids.ts";
import type { CanUseComputer } from "../../../proofs/can-use-computer.ts";
import type { Named } from "../../../proofs/proof.ts";
import type { ReachesChat } from "../../../proofs/reaches-chat.ts";
import { processLayer, Tier } from "../../../tiers.ts";
import { placeOf } from "../computer/tools.ts";
import { startDesktop } from "./browser.ts";

/**
 * A bot's desktop in a chat, opened by a member to watch or take over: where
 * the browser it drives is shown, on the computer the bot works on there, the
 * chat's project's. Whoever reaches the chat may watch it while the bot takes
 * part in the chat and uses computers, a private bot they don't reach
 * included, as they talk to it there; whoever may change
 * things there may take it over, clicking and typing on it. Opening it uses
 * the computer as a turn would, resuming it, or making it if the project has
 * none, and starts the desktop if it isn't running; the computer stays awake
 * while it is open.
 *
 * The desktop viewer operation proves again, with these, whenever who reaches
 * what changes, and closes it once the member may no longer see it as it was
 * opened for them.
 */
export interface Interface {
	/**
	 * The chat's project's computer, opened for the member to view the bot's
	 * desktop on, and held awake for as long as the scope is open. Refused
	 * while the bot takes no part in the chat, uses no computer, or the
	 * workspace's computers are switched off.
	 */
	readonly openComputer: <P, C, B>(
		chat: ReachesChat<P, C>,
		bot: Named<B, string>,
	) => Effect.Effect<OpenedComputer, DesktopUnavailable | Computers.Unavailable, Scope.Scope>;
	/**
	 * Starts the bot's desktop on `opened`, and answers where its VNC server
	 * takes a WebSocket: the one that takes the member's clicks and keys when
	 * `canUse` lets them take it over, else one that ignores them.
	 */
	readonly show: <P, M>(
		opened: OpenedComputer,
		canUse: CanUseComputer<P, M>,
	) => Effect.Effect<OpenDesktop, DesktopUnavailable | Computers.Unavailable, Scope.Scope>;
	/**
	 * The id of the computer the bot's desktop in the chat is shown on, for
	 * proving again that the member may still use it: refused once the bot
	 * left the chat or stopped using its computer, or the computer is gone.
	 */
	readonly stillShown: <P, C, B>(
		chat: ReachesChat<P, C>,
		bot: Named<B, string>,
	) => Effect.Effect<string, DesktopUnavailable>;
}

/** A computer opened for a desktop viewer, for {@link Interface.show}. */
interface OpenedComputer {
	/** The computer's id, which `CanUseComputer` is proved about. */
	readonly id: string;
	readonly computer: Computers.Computer;
	readonly holder: ProjectComputers.Holder;
	readonly chat: string;
	readonly bot: { readonly id: string; readonly color: BotColor };
}

/**
 * The VNC server a member reaches the desktop through, and its password, for
 * Sugabots to answer with on their behalf: they never see it.
 */
export interface OpenDesktop {
	readonly endpoint: Pick<Computers.Endpoint, "url" | "headers">;
	readonly password: string;
	/** Whether the member's clicks and keys reach the desktop. */
	readonly control: boolean;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/DesktopViewer") {
	declare readonly [Tier]: "process";
}

export const make = Effect.gen(function* () {
	const projectComputers = yield* ProjectComputers.Service;
	const providers = yield* ComputerProviderStore.Service;
	const ids = yield* Ids.Service;
	const operation = yield* serviceOperations<Interface>("DesktopViewer");

	/**
	 * Whether the bot is the one the chat is with, or was added to it and is
	 * still one of its project's bots: a bot that left the project, as one made
	 * private leaves a public one, no longer works on its computer.
	 */
	const takesPart = <P, C, B>(chat: ReachesChat<P, C>, bot: Named<B, string>) =>
		chat.project.defaultOf?.id === bot.value
			? Effect.succeed(true)
			: query((db) =>
					db
						.select({ id: chatParticipant.id })
						.from(chatParticipant)
						.innerJoin(
							projectBot,
							and(
								eq(projectBot.projectId, chat.project.id),
								eq(projectBot.botId, chatParticipant.botId),
							),
						)
						.where(
							and(
								eq(chatParticipant.chatId, chat.chat.value),
								eq(chatParticipant.botId, bot.value),
							),
						)
						.limit(1),
				).pipe(Effect.map((rows) => rows.length > 0));

	/**
	 * The bot, with its colour, once it is found to take part in the chat and
	 * use a computer there.
	 */
	const requireShown = <P, C, B>(chat: ReachesChat<P, C>, bot: Named<B, string>) =>
		Effect.gen(function* () {
			if (!(yield* takesPart(chat, bot))) {
				return yield* new DesktopUnavailable({ reason: NOT_IN_THIS_CHAT });
			}
			const [found] = yield* query((db) =>
				db
					.select({ usesComputer: botTable.usesComputer, color: botTable.color })
					.from(botTable)
					.where(eq(botTable.id, bot.value))
					.limit(1),
			);
			// The UI hides the desktop then too, but this is what stops a request
			// from making a computer for a bot that a computer manager kept off.
			if (!found?.usesComputer) {
				return yield* new DesktopUnavailable({ reason: NO_COMPUTER });
			}
			return { id: bot.value, color: found.color };
		});

	return Service.of({
		openComputer: (chat, bot) =>
			operation(
				"openComputer",
				Effect.gen(function* () {
					const shown = yield* requireShown(chat, bot);
					const place = { workspaceId: chat.workspace, projectId: chat.project.id };
					const provider = yield* providers.enabled(place.workspaceId);
					if (!provider) return yield* new DesktopUnavailable({ reason: COMPUTERS_OFF });
					const holder: ProjectComputers.Holder = { kind: "viewer", id: yield* ids.random };
					yield* Effect.addFinalizer(() => projectComputers.release(holder));
					const { computer } = yield* projectComputers.open(place, provider, holder);
					const id = yield* computerOf(place.projectId, provider.id);
					if (id === undefined) return yield* new DesktopUnavailable({ reason: NO_COMPUTER });
					return {
						id,
						computer,
						holder,
						chat: chat.chat.value,
						bot: shown,
					};
				}),
			),

		show: (opened, canUse) =>
			operation(
				"show",
				Effect.gen(function* () {
					if (canUse.computer.value !== opened.id) {
						return yield* Effect.die(
							new Error("A desktop was shown with another computer's proof"),
						);
					}
					const turn = { chatId: opened.chat, botId: opened.bot.id, color: opened.bot.color };
					const desktop = yield* startDesktop(opened.computer, placeOf(turn), turn);
					// The watch server ignores input, so a viewer's mouse and keys never
					// reach the desktop, whatever their client sends.
					const server = canUse.control ? desktop.control : desktop.watch;
					yield* Effect.forkScoped(
						projectComputers
							.renew(opened.holder)
							.pipe(Effect.delay(ProjectComputers.LEASE_RENEWAL), Effect.forever),
					);
					return {
						endpoint: yield* opened.computer.endpoint(server.port),
						password: server.password,
						control: canUse.control,
					};
				}),
			),

		stillShown: (chat, bot) =>
			operation(
				"stillShown",
				Effect.gen(function* () {
					yield* requireShown(chat, bot);
					// A desktop opened through a provider closes once it is no longer
					// the workspace's: switched off, or another switched on instead.
					const provider = yield* providers.enabled(chat.workspace);
					if (!provider) return yield* new DesktopUnavailable({ reason: COMPUTERS_OFF });
					const id = yield* computerOf(chat.project.id, provider.id);
					if (id === undefined) return yield* new DesktopUnavailable({ reason: NO_COMPUTER });
					return id;
				}),
			),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps.pipe(
	Layer.provide([ProjectComputers.layer, ComputerProviderStore.layer]),
);

/** The id of the project's computer, if it has one, and it was made by the provider `providerId`. */
const computerOf = (projectId: string, providerId: string) =>
	query((db) =>
		db
			.select({ id: computerTable.id })
			.from(computerTable)
			.where(
				and(
					eq(computerTable.projectId, projectId),
					eq(computerTable.computerProviderId, providerId),
				),
			)
			.limit(1),
	).pipe(Effect.map(([row]) => row?.id));

const NOT_IN_THIS_CHAT = userText`This bot has no desktop in this chat.`;
const NO_COMPUTER = userText`This bot doesn't use a computer, so it has no desktop.`;
const COMPUTERS_OFF = userText`Computers are switched off for this workspace, so there's no desktop to open.`;
