import { channelSlugSchema, slugify } from "@sugabots/contracts";
import { BadRequest, Conflict, NotFound } from "@sugabots/contracts/http";
import { ChannelAdministration } from "@sugabots/core/workspaces/channels/channel-administration";
import { userText } from "@sugabots/errors";
import { Effect, Result, Schema, SchemaIssue } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

const slugIssues = SchemaIssue.makeFormatterStandardSchemaV1();

/** Channels, and who and which bots are in them. `ChannelAdministration` decides who may do what. */
export const channelRoutes = HttpApiBuilder.group(ServerApi, "channels", (handlers) =>
	Effect.gen(function* () {
		const channels = yield* ChannelAdministration.Service;
		return handlers
			.handle("list", ({ params }) =>
				channels
					.list({ workspace: params.workspace })
					.pipe(asSessionUser, asHttpError(channelErrors)),
			)
			.handle("create", ({ params, payload }) =>
				Effect.gen(function* () {
					// Derived before anything is written, so an unsluggable name such as
					// "!!!" is a bad request about the name rather than a slug conflict.
					const proposedSlug = payload.slug ?? slugify(payload.name);
					const slug = Schema.decodeResult(channelSlugSchema)(proposedSlug);
					if (Result.isFailure(slug)) {
						return yield* new BadRequest({
							message: userText`That name cannot be a channel's address`,
							details: slugIssues(slug.failure.issue).issues,
						});
					}
					return yield* channels
						.create({
							workspace: params.workspace,
							name: payload.name,
							slug: slug.success,
							color: payload.color,
							description: payload.description,
							visibility: payload.visibility,
						})
						.pipe(asSessionUser, asHttpError(channelErrors));
				}),
			)
			.handle("update", ({ params, payload }) =>
				channels
					.update({ channelId: params.channelId, changes: payload })
					.pipe(asSessionUser, asHttpError(channelErrors)),
			)
			.handle("remove", ({ params }) =>
				channels
					.remove({ channelId: params.channelId })
					.pipe(asSessionUser, asHttpError(channelErrors)),
			)
			.handle("listMembers", ({ params }) =>
				channels
					.members({ channelId: params.channelId })
					.pipe(asSessionUser, asHttpError(channelErrors)),
			)
			.handle("addMember", ({ params, payload }) =>
				channels
					.addMember({ channelId: params.channelId, userId: payload.userId })
					.pipe(asSessionUser, asHttpError(channelErrors)),
			)
			.handle("removeMember", ({ params }) =>
				channels
					.removeMember({ channelId: params.channelId, userId: params.userId })
					.pipe(asSessionUser, asHttpError(channelErrors)),
			)
			.handle("leave", ({ params }) =>
				channels
					.leave({ channelId: params.channelId })
					.pipe(asSessionUser, asHttpError(channelErrors)),
			)
			.handle("join", ({ params }) =>
				channels
					.join({ channelId: params.channelId })
					.pipe(asSessionUser, asHttpError(channelErrors)),
			)
			.handle("listBots", ({ params }) =>
				channels
					.bots({ channelId: params.channelId })
					.pipe(asSessionUser, asHttpError(channelErrors)),
			)
			.handle("addBot", ({ params, payload }) =>
				channels
					.addBot({ channelId: params.channelId, botId: payload.botId })
					.pipe(asSessionUser, asHttpError(channelErrors)),
			)
			.handle("removeBot", ({ params }) =>
				channels
					.removeBot({ channelId: params.channelId, botId: params.botId })
					.pipe(asSessionUser, asHttpError(channelErrors)),
			);
	}),
);

/** What each way a channel write can fail means over HTTP. */
const channelErrors = {
	...refusals,
	ChannelSlugTaken: Conflict,
	EmptyChannelUpdate: BadRequest,
	ChannelGone: NotFound,
	AdministratorInEveryChannel: BadRequest,
	NotInWorkspace: BadRequest,
	NotInChannel: NotFound,
	BotNotPublic: BadRequest,
};
