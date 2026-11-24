export * as FilePages from "./pages.ts";

import { Context, Data, DateTime, Effect, Layer, Schema } from "effect";
import { type AuthorizationDenied, ResourceHidden } from "../authorization/access.ts";
import type { CurrentActor } from "../authorization/current-actor.ts";
import { BlobStore } from "../blob-store/blob-store.ts";
import { serviceOperations } from "../database/database.ts";
import { Secrets } from "../secrets/secrets.ts";
import { ServerSettings } from "../server-settings/server-settings.ts";
import { Files } from "./files.ts";

/**
 * Bot-made HTML pages served from the server's content origin, an
 * origin of their own, so a page shares nothing with the app: not its
 * cookies, not its site, not its process. The content origin has no session,
 * so a page is reached by an address that carries its own permission: a
 * token naming the page, encrypted for that one use, given out to someone who may read it and
 * good for a few minutes.
 */
export interface Interface {
	/**
	 * Where version `version` of the file loads from on the content
	 * origin, for the next few minutes. `undefined` when no content origin is
	 * set, or when the file is not an HTML page.
	 */
	readonly address: (
		at: Files.InFile & { version: number },
	) => Effect.Effect<string | undefined, AuthorizationDenied, CurrentActor.Service>;
	/** The page an address's token names, while the address is good. */
	readonly open: (token: string) => Effect.Effect<Page, PageUnavailable>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/FilePages") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("FilePages");
	const serverSettings = yield* ServerSettings.Service;
	const secrets = yield* Secrets.Service;
	const files = yield* Files.Service;
	const readVersion = Files.readVersionUnchecked(yield* BlobStore.Service);

	return Service.of({
		address: (at) =>
			operation(
				"address",
				Effect.gen(function* () {
					const { contentOrigin } = serverSettings;
					if (!contentOrigin) return undefined;
					const page = yield* files.summary(at);
					if (page.kind !== "html") return undefined;
					// Versions are numbered from 1 to the current one, with none removed.
					if (at.version < 1 || at.version > page.version) {
						return yield* new ResourceHidden({ resource: "file" });
					}
					const now = yield* DateTime.nowAsDate;
					const address: PageAddress = {
						fileId: at.fileId,
						version: at.version,
						expiresAt: now.getTime() + ADDRESS_LIFETIME_MS,
					};
					const token = secrets.encrypt(JSON.stringify(address), SECRET_PURPOSE);
					return `${contentOrigin}${PAGE_PATH}/${token}`;
				}),
			),

		open: (token) =>
			operation(
				"open",
				Effect.gen(function* () {
					const address = yield* Effect.try({
						try: () =>
							Schema.decodeUnknownSync(pageAddressSchema)(
								JSON.parse(secrets.decrypt(token, SECRET_PURPOSE)),
							),
						catch: () => new PageUnavailable(),
					});
					const now = yield* DateTime.nowAsDate;
					if (address.expiresAt <= now.getTime()) return yield* new PageUnavailable();
					const shown = yield* readVersion(address.fileId, address.version);
					if (shown?.kind !== "html") return yield* new PageUnavailable();
					return { title: shown.title, html: shown.content };
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide(Files.layer));

/** The path on the content origin that pages are served under, before the token. */
export const PAGE_PATH = "/pages";

/** How long an address stays good. Long enough to load a page, short enough that a copied address soon stops working. */
const ADDRESS_LIFETIME_MS = 10 * 60 * 1000;

interface Page {
	title: string;
	html: string;
}

/** The use page addresses are encrypted for, so no other value encrypted with the same key opens as one. */
export const SECRET_PURPOSE = "file-page-address";

const pageAddressSchema = Schema.Struct({
	fileId: Schema.String,
	version: Schema.Int,
	/** In milliseconds since the epoch. */
	expiresAt: Schema.Number,
});

type PageAddress = typeof pageAddressSchema.Type;

/** The address was never given out, has been tampered with, has expired, or names a page that is gone. */
export class PageUnavailable extends Data.TaggedError("FilePageUnavailable") {}
