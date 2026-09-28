import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { EventBus } from "@sugabots/core/database/events/bus";
import { Config, Duration, Effect, Layer } from "effect";
import { HttpServer } from "effect/unstable/http";
import { VERSION } from "../version.ts";

/**
 * How long a client gets to finish what it was sent before its socket is cut.
 *
 * Past this the process is holding the port and, in development, the watcher
 * cannot restart. A request still running here was going to be abandoned by
 * the restart anyway.
 */
const SHUTDOWN_GRACE = Duration.seconds(3);

/** Node's HTTP server on `PORT`, closed with {@link SHUTDOWN_GRACE} when its scope is. */
export const nodeServerLayer = NodeHttpServer.layerConfig(createServer, {
	port: Config.Port("PORT").pipe(Config.withDefault(3000)),
	gracefulShutdownTimeout: Config.succeed(SHUTDOWN_GRACE),
});

/**
 * Says where the server listens and, built after the server, closes before
 * it: its finalizer ends the event streams, so the server's own close does not
 * wait out its grace on them. Each holds a socket open for as long as its
 * browser is there.
 */
export const listeningLayer = Layer.effectDiscard(
	Effect.gen(function* () {
		const bus = yield* EventBus.Service;
		yield* Effect.addFinalizer(() => Effect.promise(() => bus.close()));
		yield* HttpServer.addressFormattedWith((address) =>
			Effect.log(`sugabots ${VERSION} listening on ${address}`),
		);
	}),
);
