export * as ArtifactPages from "./pages.ts";

import { Context, Data, DateTime, Effect, Layer, Schema } from "effect";
import { type AuthorizationDenied, ResourceHidden } from "../authorization/access.ts";
import type { CurrentActor } from "../authorization/current-actor.ts";
import { BlobStore } from "../blob-store/blob-store.ts";
import { Credentials } from "../credentials/credentials.ts";
import { serviceOperations } from "../database/database.ts";
import { Installation } from "../installation/installation.ts";
import { Artifacts } from "./artifacts.ts";

/**
 * Bot-made HTML pages served from the installation's content origin, an
 * origin of their own, so a page shares nothing with the app: not its
 * cookies, not its site, not its process. The content origin has no session,
 * so a page is reached by an address that carries its own permission: a
 * sealed token naming the page, given out to someone who may read it and
 * good for a few minutes.
 */
export interface Interface {
	/**
	 * Where version `version` of the artifact loads from on the content
	 * origin, for the next few minutes. `undefined` when no content origin is
	 * set, or when the artifact is not an HTML page.
	 */
	readonly address: (
		at: Artifacts.InArtifact & { version: number },
	) => Effect.Effect<string | undefined, AuthorizationDenied, CurrentActor.Service>;
	/** The page an address's token names, while the address is good. */
	readonly open: (token: string) => Effect.Effect<Page, PageUnavailable>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ArtifactPages",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ArtifactPages");
	const installation = yield* Installation.Service;
	const credentials = yield* Credentials.Service;
	const artifacts = yield* Artifacts.Service;
	const readVersion = Artifacts.readVersionUnchecked(yield* BlobStore.Service);

	return Service.of({
		address: (at) =>
			operation(
				"address",
				Effect.gen(function* () {
					const { contentOrigin } = installation;
					if (!contentOrigin) return undefined;
					const page = yield* artifacts.summary(at);
					if (page.kind !== "html") return undefined;
					// Versions are numbered from 1 to the current one, with none removed.
					if (at.version < 1 || at.version > page.version) {
						return yield* new ResourceHidden({ resource: "artifact" });
					}
					const now = yield* DateTime.nowAsDate;
					const sealed: SealedPage = {
						podId: at.podId,
						artifactId: at.artifactId,
						version: at.version,
						expiresAt: now.getTime() + ADDRESS_LIFETIME_MS,
					};
					const token = credentials.encrypt(JSON.stringify(sealed), SEALED_FOR);
					return `${contentOrigin}${PAGE_PATH}/${token}`;
				}),
			),

		open: (token) =>
			operation(
				"open",
				Effect.gen(function* () {
					const sealed = yield* Effect.try({
						try: () =>
							Schema.decodeUnknownSync(sealedPageSchema)(
								JSON.parse(credentials.decrypt(token, SEALED_FOR)),
							),
						catch: () => new PageUnavailable(),
					});
					const now = yield* DateTime.nowAsDate;
					if (sealed.expiresAt <= now.getTime()) return yield* new PageUnavailable();
					const shown = yield* readVersion(sealed.podId, sealed.artifactId, sealed.version);
					if (!shown || shown.kind !== "html") return yield* new PageUnavailable();
					return { title: shown.title, html: shown.content };
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide(Artifacts.layer));

/** The path on the content origin that pages are served under, before the token. */
export const PAGE_PATH = "/pages";

/** How long an address stays good. Long enough to load a page, short enough that a copied address soon stops working. */
const ADDRESS_LIFETIME_MS = 10 * 60 * 1000;

export interface Page {
	title: string;
	html: string;
}

/** What page addresses are sealed for, so no other value sealed with the same key opens as one. */
export const SEALED_FOR = "artifact-page-address";

const sealedPageSchema = Schema.Struct({
	podId: Schema.String,
	artifactId: Schema.String,
	version: Schema.Int,
	/** In milliseconds since the epoch. */
	expiresAt: Schema.Number,
});

type SealedPage = typeof sealedPageSchema.Type;

/** The address was never given out, has been tampered with, has expired, or names a page that is gone. */
export class PageUnavailable extends Data.TaggedError("ArtifactPageUnavailable") {}
