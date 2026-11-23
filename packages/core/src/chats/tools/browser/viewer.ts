export * as DesktopViewer from "./viewer.ts";

import { userText } from "@sugabots/errors";
import { and, eq, sql } from "drizzle-orm";
import { Context, Deferred, Duration, Effect, Layer, type Scope } from "effect";
import { type AuthorizationDenied, computerProjectIdOf } from "../../../authorization/access.ts";
import { Authorization } from "../../../authorization/authorization.ts";
import type { CurrentActor } from "../../../authorization/current-actor.ts";
import { Visibility } from "../../../authorization/visibility.ts";
import { ComputerProviderStore } from "../../../computers/computer-provider-store.ts";
import type { Computers } from "../../../computers/computers.ts";
import { ProjectComputers } from "../../../computers/project-computers.ts";
import { query, serviceOperations } from "../../../database/database.ts";
import { chatParticipant, placedChat } from "../../../database/schema.ts";
import { Ids } from "../../../ids/ids.ts";
import { placeOf } from "../computer/tools.ts";
import { DesktopUnavailable, startDesktop } from "./browser.ts";

/**
 * A bot's desktop in a chat, opened by a person to watch and use: where
 * the browser it drives is shown, on the computer the bot works on there, the
 * chat's project's (in a collaboration, the bot's own default
 * project's). Anyone who can read the chat, see the bot and see that
 * computer may open it, while the bot takes part in the chat and uses
 * computers. Those holding `computer.desktop.use` in the computer's project
 * may click and type on it too; anyone else only watches. Opening it uses the
 * computer as a turn would, resuming it, or making it if the project has
 * none, and starts the desktop if it isn't running; the computer stays awake
 * while it is open, and while the person may still see it as it was opened
 * for them.
 */
export interface Interface {
	/**
	 * Where the desktop's VNC server takes a WebSocket, and its password, for
	 * as long as the scope is open, which holds the computer awake.
	 */
	readonly open: (input: {
		chatId: string;
		botId: string;
	}) => Effect.Effect<
		OpenDesktop,
		AuthorizationDenied | DesktopUnavailable | Computers.Unavailable,
		CurrentActor.Service | Scope.Scope
	>;
}

/**
 * The VNC server a person reaches the desktop through, and its password, for
 * Sugabots to answer with on their behalf: they never see it.
 */
export interface OpenDesktop {
	readonly endpoint: Computers.Endpoint;
	readonly password: string;
	/**
	 * Completes once the person may no longer see the desktop as it was opened
	 * for them: they no longer reach the chat or the bot, the bot left
	 * the chat or stopped using its computer, or they could click and
	 * type and no longer may. Checked every `ACCESS_CHECK_INTERVAL`; the
	 * computer is kept awake for them no longer from then.
	 */
	readonly accessLost: Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/DesktopViewer",
) {}

export const make = Effect.gen(function* () {
	const visibility = yield* Visibility.Service;
	const authorization = yield* Authorization.Service;
	const projectComputers = yield* ProjectComputers.Service;
	const providers = yield* ComputerProviderStore.Service;
	const ids = yield* Ids.Service;
	const operation = yield* serviceOperations<Interface>("DesktopViewer");

	/** Whether the bot is the one the chat is with, or was added to it. */
	const takesPart = (chat: { id: string; botId: string | null }, botId: string) =>
		chat.botId === botId
			? Effect.succeed(true)
			: operation(
					"open",
					query((db) =>
						db
							.select({ id: chatParticipant.id })
							.from(chatParticipant)
							.where(and(eq(chatParticipant.chatId, chat.id), eq(chatParticipant.botId, botId)))
							.limit(1),
					),
				).pipe(Effect.map((rows) => rows.length > 0));

	/**
	 * The project whose computer the bot works on in the chat: the
	 * chat's, or in a collaboration the bot's own default project, as a
	 * turn's is chosen.
	 */
	const computerProjectOf = (chatId: string, botId: string) =>
		operation(
			"open",
			query((db) =>
				db
					.select({ id: computerProjectIdOf(placedChat, sql`${botId}::uuid`) })
					.from(placedChat)
					.where(eq(placedChat.id, chatId))
					.limit(1),
			),
		).pipe(Effect.map(([row]) => row?.id ?? undefined));

	/**
	 * The actor's standing towards the bot and the project whose computer it
	 * works on in the chat, when they may see its desktop there.
	 */
	const desktopStanding = (chatId: string, botId: string) =>
		Effect.gen(function* () {
			const { chat } = yield* visibility.chatStanding(chatId);
			const { bot } = yield* authorization.bot(botId, "bot.read");
			if (!(yield* takesPart(chat, botId))) {
				return yield* new DesktopUnavailable({ reason: NOT_IN_THIS_CHAT });
			}
			const projectId = yield* computerProjectOf(chat.id, botId);
			if (projectId === undefined) {
				return yield* new DesktopUnavailable({ reason: NO_COMPUTER });
			}
			const computerProject = yield* authorization.project(projectId, "computer.read");
			return { chat, bot, computerProject };
		});

	/**
	 * Whether the actor may still see the bot's desktop in the chat as
	 * `open` let them, clicking and typing on it when `controls`.
	 */
	const stillAllowed = (input: { chatId: string; botId: string; controls: boolean }) =>
		Effect.gen(function* () {
			const { bot, computerProject } = yield* desktopStanding(input.chatId, input.botId);
			if (!bot.usesComputer) return false;
			return !input.controls || computerProject.may("computer.desktop.use");
		}).pipe(
			Effect.catchTags({
				ResourceHidden: () => Effect.succeed(false),
				ActionForbidden: () => Effect.succeed(false),
				DesktopUnavailable: () => Effect.succeed(false),
			}),
		);

	return Service.of({
		open: ({ chatId, botId }) =>
			Effect.gen(function* () {
				const { chat, bot, computerProject } = yield* desktopStanding(chatId, botId);
				// The UI hides the desktop then too, but this is what stops a request
				// from making a computer for a bot that a computer manager kept off.
				if (!bot.usesComputer) return yield* new DesktopUnavailable({ reason: NO_COMPUTER });
				const owner = {
					workspaceId: chat.workspaceId,
					projectId: computerProject.project.id,
				};
				const provider = yield* providers.enabled(owner.workspaceId);
				if (!provider) return yield* new DesktopUnavailable({ reason: COMPUTERS_OFF });
				const holder: ProjectComputers.Holder = { kind: "viewer", id: yield* ids.random };
				yield* Effect.addFinalizer(() => projectComputers.release(holder));
				const { computer } = yield* projectComputers.open(owner, provider, holder);
				const turn = { chatId, botId, color: bot.color };
				const desktop = yield* startDesktop(computer, placeOf(turn), turn);
				// The watch server ignores input, so a viewer's mouse and keys never
				// reach the desktop, whatever their client sends.
				const controls = computerProject.may("computer.desktop.use");
				const server = controls ? desktop.control : desktop.watch;
				const lost = yield* Deferred.make<void>();
				yield* Effect.forkScoped(
					Effect.sleep(ACCESS_CHECK_INTERVAL).pipe(
						Effect.andThen(stillAllowed({ chatId, botId, controls })),
						Effect.repeat({ while: (allowed) => allowed }),
						Effect.andThen(Deferred.succeed(lost, undefined)),
					),
				);
				yield* Effect.forkScoped(
					projectComputers
						.renew(holder)
						.pipe(
							Effect.delay(ProjectComputers.LEASE_RENEWAL),
							Effect.forever,
							Effect.raceFirst(Deferred.await(lost)),
						),
				);
				return {
					endpoint: yield* computer.endpoint(server.port),
					password: server.password,
					accessLost: Deferred.await(lost),
				};
			}),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([
		Visibility.layer,
		Authorization.layer,
		ProjectComputers.layer,
		ComputerProviderStore.layer,
	]),
);

/** How often an open desktop checks its person may still see it. */
const ACCESS_CHECK_INTERVAL = Duration.seconds(10);

const NOT_IN_THIS_CHAT = userText`This bot has no desktop in this chat.`;
const NO_COMPUTER = userText`This bot doesn't use a computer, so it has no desktop.`;
const COMPUTERS_OFF = userText`Computers are switched off for this workspace, so there's no desktop to open.`;
