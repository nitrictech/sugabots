import { BadRequest, Conflict, Forbidden, NotFound } from "@sugabots/contracts/http";
import { Membership } from "@sugabots/core/workspaces/membership/membership";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

/** `Membership` decides who may do what; these map its refusals to HTTP. */
export const workspaceRoutes = HttpApiBuilder.group(ServerApi, "workspaces", (handlers) =>
	Effect.gen(function* () {
		const membership = yield* Membership.Service;
		return handlers
			.handle("list", () => asSessionUser(membership.workspaces))
			.handle("create", ({ payload }) =>
				membership.create({ details: payload }).pipe(
					asSessionUser,
					asHttpError({
						SlugTaken: Conflict,
						SlugShapedLikeUuid: BadRequest,
						TimeZoneUnknown: BadRequest,
					}),
				),
			)
			.handle("update", ({ params, payload }) =>
				membership
					.update({ workspace: params.workspace, details: payload })
					.pipe(
						asSessionUser,
						asHttpError({ ...refusals, SlugTaken: Conflict, SlugShapedLikeUuid: BadRequest }),
					),
			)
			.handle("delete", ({ params }) =>
				membership
					.delete({ workspace: params.workspace })
					.pipe(asSessionUser, asHttpError(refusals)),
			)
			.handle("members", ({ params }) =>
				membership
					.members({ workspace: params.workspace })
					.pipe(asSessionUser, asHttpError(refusals)),
			)
			.handle("updateMember", ({ params, payload }) =>
				membership
					.changeRole({
						workspace: params.workspace,
						memberId: params.memberId,
						role: payload.role,
					})
					.pipe(asSessionUser, asHttpError({ ...refusals, OwnerStays: BadRequest })),
			)
			.handle("removeMember", ({ params }) =>
				membership
					.remove({ workspace: params.workspace, memberId: params.memberId })
					.pipe(asSessionUser, asHttpError({ ...refusals, OwnerStays: BadRequest })),
			)
			.handle("leave", ({ params }) =>
				membership
					.leave({ workspace: params.workspace })
					.pipe(asSessionUser, asHttpError({ ...refusals, OwnerStays: BadRequest })),
			)
			.handle("transferOwnership", ({ params, payload }) =>
				membership
					.transferOwnership({ workspace: params.workspace, memberId: payload.memberId })
					.pipe(asSessionUser, asHttpError(refusals)),
			)
			.handle("invitations", ({ params }) =>
				membership
					.invitations({ workspace: params.workspace })
					.pipe(asSessionUser, asHttpError(refusals)),
			)
			.handle("invite", ({ params, payload }) =>
				membership
					.invite({ workspace: params.workspace, invitation: payload })
					.pipe(
						asSessionUser,
						asHttpError({ ...refusals, AlreadyMember: Conflict, AlreadyInvited: Conflict }),
					),
			)
			.handle("cancelInvitation", ({ params }) =>
				membership
					.cancelInvitation({ invitationId: params.invitationId })
					.pipe(asSessionUser, asHttpError(refusals)),
			)
			.handle("invitation", ({ params }) =>
				membership
					.invitation({ invitationId: params.invitationId })
					.pipe(asSessionUser, asHttpError({ ResourceHidden: NotFound, NotTheInvitee: Forbidden })),
			)
			.handle("acceptInvitation", ({ params }) =>
				membership.accept({ invitationId: params.invitationId }).pipe(
					asSessionUser,
					Effect.catchTag("EmailUnverified", (unverified) =>
						Effect.fail(
							new Forbidden({ message: unverified.userMessage, details: EMAIL_UNVERIFIED }),
						),
					),
					asHttpError({ ResourceHidden: NotFound, NotTheInvitee: Forbidden }),
				),
			);
	}),
);

/**
 * The code a client reads to tell "verify your address first" from the other
 * refusals that share its status. `isEmailUnverified` in the SDK knows it.
 */
const EMAIL_UNVERIFIED = "EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION";
