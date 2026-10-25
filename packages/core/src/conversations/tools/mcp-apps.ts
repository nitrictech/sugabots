export * as McpApps from "./mcp-apps.ts";

import type { CallToolResult } from "@ai-sdk/mcp";
import { type UserText, userText } from "@sugabots/errors";
import { eq } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import type { ResourceHidden } from "../../authorization/access.ts";
import type { CurrentActor } from "../../authorization/current-actor.ts";
import { Visibility } from "../../authorization/visibility.ts";
import { query, serviceOperations } from "../../database/database.ts";
import { toolCall } from "../../database/schema.ts";
import { isUuid } from "../../ids/ids.ts";
import { ConnectionRepository } from "../../providers/connections/connection-repository.ts";
import { ConnectionSignIn } from "../../providers/connections/connection-sign-in.ts";
import type { ConnectionTarget } from "../../providers/connections/connection-target.ts";
import { connectServer, type ServerSession } from "../../providers/connections/mcp.ts";
import { toolAccessOf } from "../../providers/connections/tool-access.ts";
import { Egress } from "../../providers/network/egress.ts";
import type { UserFacing } from "../../user-message.ts";

/**
 * The MCP Apps a thread's tool calls are shown in: the HTML each one's
 * server gives for it, and the calls an app makes back to that server.
 *
 * Both are open to whoever sees the thread, and go through the connection
 * the call was made with, as it is configured now. An app may call only
 * the tools its server shows to apps, and only those the pod lets its bots
 * run without asking; an app's calls are not recorded in the thread.
 */
export interface Interface {
	readonly resource: (
		toolCallId: string,
	) => Effect.Effect<Resource, ResourceHidden | McpAppUnavailable, CurrentActor.Service>;
	readonly callTool: (
		toolCallId: string,
		call: { name: string; arguments: Record<string, unknown> },
	) => Effect.Effect<
		CallToolResult,
		ResourceHidden | McpAppUnavailable | McpAppToolRefused,
		CurrentActor.Service
	>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/McpApps") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("McpApps");
	const visibility = yield* Visibility.Service;
	const connections = yield* ConnectionRepository.Service;
	const signIn = yield* ConnectionSignIn.Service;
	const egress = yield* Egress.Service;

	/** The call's app and the connection it reaches its server through, once the actor sees its thread. */
	const appOf = (toolCallId: string) =>
		Effect.gen(function* () {
			if (!isUuid(toolCallId)) return yield* new McpAppUnavailable();
			const [call] = yield* query((db) =>
				db
					.select({
						threadId: toolCall.threadId,
						connectionId: toolCall.connectionId,
						appResourceUri: toolCall.appResourceUri,
					})
					.from(toolCall)
					.where(eq(toolCall.id, toolCallId))
					.limit(1),
			);
			if (!call) return yield* new McpAppUnavailable();
			const { thread } = yield* visibility.thread(call.threadId);
			if (!call.connectionId || !call.appResourceUri) return yield* new McpAppUnavailable();
			const target = yield* connections.target(thread.workspaceId, thread.podId, call.connectionId);
			if (target?.kind !== "mcp") return yield* new McpAppUnavailable();
			return { workspaceId: thread.workspaceId, target, resourceUri: call.appResourceUri };
		});

	const withSession = <A>(
		workspaceId: string,
		target: ConnectionTarget,
		use: (session: ServerSession) => Promise<A>,
	) =>
		Effect.gen(function* () {
			const clients = yield* signIn.clients;
			return yield* Effect.acquireUseRelease(
				Effect.tryPromise(() =>
					connectServer(
						{
							url: target.url,
							headers: target.headers,
							authProvider:
								target.auth === "oauth" ? clients.for(workspaceId, target.connectionId) : undefined,
						},
						target.auth === "oauth" ? egress.oauth : egress.providers.for({ baseUrl: target.url }),
					),
				),
				(session) => Effect.tryPromise(() => use(session)),
				(session) => Effect.promise(() => session.close()),
			);
		}).pipe(
			Effect.catchTag("UnknownError", (failure) =>
				Effect.andThen(
					Effect.logError(`MCP App on ${target.handle} failed`, failure.cause),
					Effect.fail(new McpAppUnavailable()),
				),
			),
		);

	return Service.of({
		resource: (toolCallId) =>
			operation(
				"resource",
				Effect.gen(function* () {
					const { workspaceId, target, resourceUri } = yield* appOf(toolCallId);
					const read = yield* withSession(workspaceId, target, (session) =>
						session.readApp(resourceUri),
					);
					return {
						html: read.html,
						csp: {
							connectDomains: read.meta?.csp?.connectDomains ?? [],
							resourceDomains: read.meta?.csp?.resourceDomains ?? [],
							frameDomains: read.meta?.csp?.frameDomains ?? [],
						},
						prefersBorder: read.meta?.prefersBorder ?? null,
					};
				}),
			),

		callTool: (toolCallId, call) =>
			operation(
				"callTool",
				Effect.gen(function* () {
					const { workspaceId, target } = yield* appOf(toolCallId);
					const outcome = yield* withSession(workspaceId, target, async (session) => {
						const listing = await session.list();
						const tool = listing.tools.find((listed) => listed.described.name === call.name);
						if (!tool?.visibility.app) return refusal(userText`The app has no such tool`);
						if (toolAccessOf(target.toolAccess, tool.described) !== "allow") {
							return refusal(
								userText`The pod asks before that tool runs, so the app may not run it`,
							);
						}
						return { ran: await session.callForApp(call.name, call.arguments) };
					});
					if ("refused" in outcome)
						return yield* new McpAppToolRefused({ reason: outcome.refused });
					return outcome.ran;
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([Visibility.layer, ConnectionRepository.layer, ConnectionSignIn.layer]),
);

/** What a browser needs to show an app: its HTML, and the origins it says it reaches. */
export interface Resource {
	html: string;
	csp: { connectDomains: string[]; resourceDomains: string[]; frameDomains: string[] };
	prefersBorder: boolean | null;
}

const refusal = (refused: UserText) => ({ refused });

export class McpAppUnavailable extends Data.TaggedError("McpAppUnavailable") implements UserFacing {
	get userMessage() {
		return userText`The app for this tool call can't be shown. Its connection may have changed or be unreachable`;
	}
}

export class McpAppToolRefused
	extends Data.TaggedError("McpAppToolRefused")<{ readonly reason: UserText }>
	implements UserFacing
{
	get userMessage() {
		return this.reason;
	}
}
