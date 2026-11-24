import { randomUUID } from "node:crypto";
import type { InputOf, OperationName, OutputOf } from "@sugabots/contracts/operations";
import { Context, Effect, Layer, Scope } from "effect";
import { Accounts } from "../accounts/accounts.ts";
import { chatServicesForTests } from "../chats/testing.ts";
import { noComputers } from "../computers/testing.ts";
import { EventBus } from "../database/events/bus.ts";
import { EventStore } from "../database/events/store.ts";
import { runOnPostgres, type TestInfrastructure } from "../database/testing.ts";
import { Email } from "../email/email.ts";
import type { Principal } from "../principal.ts";
import type { Egress } from "../providers/network/egress.ts";
import { ServerSettings } from "../server-settings/server-settings.ts";
import { unimplemented } from "../testing.ts";
import { layer } from "./layer.ts";
import { Operations } from "./registry.ts";

/** Calls the operation `name` with `input` for `principal`, as one request, against the test database. */
export type CallOperation = <Name extends OperationName>(
	principal: Principal,
	name: Name,
	input: InputOf<Name>,
) => Promise<OutputOf<Name>>;

/** The chat services the operations are built over, as `chatServicesForTests` composes them. */
export type ChatServicesForTests = Awaited<ReturnType<typeof chatServicesForTests>>;

/**
 * What `servedOperations` builds the operations over, beyond the test
 * infrastructure: what `index.ts` provides them. Each has a default for cases
 * about none of it.
 */
export interface ServedOver {
	/**
	 * The chat services, which the registry also takes `WorkspaceTimeZone`
	 * from; by default ones whose events go nowhere a case reads.
	 */
	readonly chats?: ChatServicesForTests;
	/** The internet, as operations reach it; by default nothing, so any request dies. */
	readonly egress?: Layer.Layer<Egress.Service>;
	/**
	 * Stands in for the test infrastructure's server settings: for a server with
	 * a content origin, or served at another address, which GitHub apps are made with.
	 */
	readonly serverSettings?: ServerSettings.Interface;
	/** How the operations send email; by default to nobody. */
	readonly email?: Email.Interface;
	/**
	 * Who may have an account, built over the test infrastructure; by default
	 * accounts that need no verified email, as a server's don't unless it is set
	 * to require one, and whose every method dies.
	 */
	readonly accounts?: Layer.Layer<Accounts.Service, never, TestInfrastructure>;
	/**
	 * The bus the operations publish to; by default one in memory, which the
	 * default chat services publish to as well.
	 */
	readonly bus?: Layer.Layer<EventBus.Service>;
}

/** Email that goes nowhere, for cases that send some but read none. */
const unsentEmail = Email.Service.of({ send: () => Effect.void });

/**
 * The operation registry with every domain's services under it, over the test
 * infrastructure, computers nobody makes and what `over` gives, as an
 * entrypoint calls it. Call it from `beforeAll`, so a file whose cases skip
 * without a database never connects. A failure rejects with the operation's
 * own error. Its services stay built for the rest of the file, so work they
 * leave running, such as uninstalling a GitHub app once a removal commits,
 * finishes.
 */
export async function servedOperations(over: ServedOver = {}): Promise<CallOperation> {
	const bus = EventBus.inProcess({ store: EventStore.inMemory() });
	const chats = over.chats ?? (await chatServicesForTests(bus));
	const outside = Layer.mergeAll(
		noComputers,
		Layer.succeedContext(chats),
		over.egress ?? Layer.empty,
		over.serverSettings ? Layer.succeed(ServerSettings.Service, over.serverSettings) : Layer.empty,
		Layer.succeed(Email.Service, over.email ?? unsentEmail),
		over.accounts ?? unimplemented(Accounts.Service, { requireEmailVerification: false }),
		over.bus ?? Layer.succeed(EventBus.Service, bus),
	);
	const operations = await runOnPostgres(
		Effect.gen(function* () {
			const built = yield* Layer.buildWithScope(
				layer.pipe(Layer.provide(outside)),
				yield* Scope.make(),
			);
			return Context.get(built, Operations.Service);
		}),
	);
	return (principal, name, input) =>
		runOnPostgres(operations[name](principal, input, { kind: "request", request: randomUUID() }));
}
