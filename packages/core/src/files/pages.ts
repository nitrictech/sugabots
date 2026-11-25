export * as FilePages from "./pages.ts";

import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { uuidSchema } from "@sugabots/contracts/uuid";
import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { serviceOperations } from "../database/database.ts";
import type { ReachesFile } from "../proofs/reaches-file.ts";
import { Secrets } from "../secrets/secrets.ts";
import { ServerSettings } from "../server-settings/server-settings.ts";
import { processLayer, Tier } from "../tiers.ts";
import { Files } from "./files.ts";

/**
 * Bot-made HTML pages served from the server's content origin, an
 * origin of their own, so a page shares nothing with the app: not its
 * cookies, not its site, not its process. The content origin has no session,
 * so a page is reached by an address that carries its own permission: a
 * token naming the page, encrypted for that one use, given out to someone
 * an operation has proved reaches it, and good for a few minutes.
 */
export interface Interface {
	/**
	 * Where version `version` of the file `reach` is about loads from on the
	 * content origin, for the next few minutes. `undefined` when no content
	 * origin is set, or when the file is not an HTML page.
	 */
	readonly address: <P, F>(
		reach: ReachesFile<P, F>,
		version: number,
	) => Effect.Effect<string | undefined, ResourceHidden>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/FilePages") {
	declare readonly [Tier]: "process";
}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("FilePages");
	const serverSettings = yield* ServerSettings.Service;
	const secrets = yield* Secrets.Service;
	const files = yield* Files.Service;

	return Service.of({
		address: (reach, version) =>
			operation(
				"address",
				Effect.gen(function* () {
					const { contentOrigin } = serverSettings;
					if (!contentOrigin) return undefined;
					const page = yield* files.summary(reach);
					if (page.kind !== "html") return undefined;
					// Versions are numbered from 1 to the current one, with none removed.
					if (version < 1 || version > page.version) {
						return yield* new ResourceHidden({ resource: "file" });
					}
					const now = yield* DateTime.nowAsDate;
					const address: PageAddress = {
						fileId: page.id,
						version,
						expiresAt: now.getTime() + ADDRESS_LIFETIME_MS,
					};
					const token = secrets.encrypt(JSON.stringify(address), SECRET_PURPOSE);
					return `${contentOrigin}${PAGE_PATH}/${token}`;
				}),
			),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps.pipe(Layer.provide(Files.layer));

/** The path on the content origin that pages are served under, before the token. */
export const PAGE_PATH = "/pages";

/** How long an address stays good. Long enough to load a page, short enough that a copied address soon stops working. */
const ADDRESS_LIFETIME_MS = 10 * 60 * 1000;

/** The use page addresses are encrypted for, so no other value encrypted with the same key opens as one. */
export const SECRET_PURPOSE = "file-page-address";

/** What a page address's token holds once opened: which version of which page, and until when. */
export const pageAddressSchema = Schema.Struct({
	fileId: uuidSchema,
	version: Schema.Int,
	/** In milliseconds since the epoch. */
	expiresAt: Schema.Number,
});

type PageAddress = typeof pageAddressSchema.Type;
