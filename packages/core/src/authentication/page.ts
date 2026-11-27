export * as PageAuthentication from "./page.ts";

import { type DomainError, userText } from "@sugabots/errors";
import { and, eq, gte } from "drizzle-orm";
import { Context, DateTime, Effect, ErrorReporter, Layer, Option, Schema } from "effect";
import { query, serviceOperations } from "../database/database.ts";
import { chat, file } from "../database/schema.ts";
import { FilePages } from "../files/pages.ts";
import { authenticated, type PageAddress } from "../principal.ts";
import { Secrets } from "../secrets/secrets.ts";
import { processLayer, Tier } from "../tiers.ts";

/**
 * The authenticator for a bot-made page's secret address, the content
 * origin's only way in: the address's token, encrypted for that one use,
 * names a page version, its recipient and its expiry. The principal it
 * builds opens only that page while the recipient still reaches it.
 */
export interface Interface {
	/** The page the address token `token` opens, while it works. */
	readonly open: (token: string) => Effect.Effect<PageAddress, PageAddressUnavailable>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/PageAuthentication",
) {
	declare readonly [Tier]: "process";
}

const decodeAddress = Schema.decodeUnknownOption(
	Schema.fromJsonString(FilePages.pageAddressSchema),
);

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("PageAuthentication");
	const secrets = yield* Secrets.Service;

	/** The token's contents, or nothing when it wasn't encrypted for a page address. */
	const opened = (token: string) => {
		try {
			return decodeAddress(secrets.decrypt(token, FilePages.SECRET_PURPOSE));
		} catch {
			return Option.none();
		}
	};

	return Service.of({
		open: (token) =>
			operation(
				"open",
				Effect.gen(function* () {
					const address = opened(token);
					if (Option.isNone(address)) return yield* new PageAddressUnavailable();
					const { fileId, memberId, version, expiresAt } = address.value;
					const now = yield* DateTime.nowAsDate;
					if (expiresAt <= now.getTime()) {
						return yield* new PageAddressUnavailable();
					}
					const [page] = yield* query((db) =>
						db
							.select({ workspace: chat.workspaceId })
							.from(file)
							.innerJoin(chat, eq(chat.id, file.chatId))
							.where(
								and(eq(file.id, fileId), eq(file.kind, "html"), gte(file.currentVersion, version)),
							)
							.limit(1),
					);
					if (!page || version < 1) return yield* new PageAddressUnavailable();
					return authenticated.pageAddress({
						workspace: page.workspace,
						file: fileId,
						member: memberId,
						version,
						expiresAt,
					});
				}),
			),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps;

/** The address was never given out, has been tampered with, has expired, or names a page that is gone. */
export class PageAddressUnavailable
	extends Schema.TaggedError<PageAddressUnavailable>()("PageAddressUnavailable", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "A page address was malformed, expired, or names no page";
	}
	get userMessage() {
		return userText`This page's address no longer works. Open the page again from its chat`;
	}
}
