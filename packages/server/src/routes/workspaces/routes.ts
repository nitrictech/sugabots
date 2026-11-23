import { BadRequest, Conflict, Forbidden, NotFound } from "@sugabots/contracts/http";
import { Membership } from "@sugabots/core/workspaces/membership/membership";
import { WorkspaceTimeZone } from "@sugabots/core/workspaces/time-zone/workspace-time-zone";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSignedInPerson } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals } from "../../http/errors.ts";

/** `Membership` and `WorkspaceTimeZone` decide who may do what; these map their refusals to HTTP. */
export const workspaceRoutes = HttpApiBuilder.group(ServerApi, "workspaces", (handlers) =>
	Effect.gen(function* () {
		const membership = yield* Membership.Service;
		const timeZones = yield* WorkspaceTimeZone.Service;
		return handlers
			.handle("list", () => asSignedInPerson(membership.workspaces))
			.handle("create", ({ payload }) =>
				membership.create({ details: payload }).pipe(
					asSignedInPerson,
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
						asSignedInPerson,
						asHttpError({ ...refusals, SlugTaken: Conflict, SlugShapedLikeUuid: BadRequest }),
					),
			)
			.handle("timeZone", ({ params }) =>
				timeZones
					.get({ workspace: params.workspace })
					.pipe(asSignedInPerson, asHttpError(refusals)),
			)
			.handle("changeTimeZone", ({ params, payload }) =>
				timeZones
					.change({ workspace: params.workspace, timeZone: payload.timeZone })
					.pipe(asSignedInPerson, asHttpError({ ...refusals, TimeZoneUnknown: BadRequest })),
			)
			.handle("delete", ({ params }) =>
				membership.delete({ workspace: params.workspace }).pipe(
					asSignedInPerson,
					asHttpError({
						...refusals,
						ComputerUnavailable: Conflict,
						ComputerMadeMeanwhile: Conflict,
					}),
				),
			)
			.handle("memberships", ({ params }) =>
				membership
					.memberships({ workspace: params.workspace })
					.pipe(asSignedInPerson, asHttpError(refusals)),
			)
			.handle("changeRole", ({ params, payload }) =>
				membership
					.changeRole({
						workspace: params.workspace,
						membershipId: params.membershipId,
						role: payload.role,
					})
					.pipe(asSignedInPerson, asHttpError({ ...refusals, OwnerStays: BadRequest })),
			)
			.handle("removeMembership", ({ params }) =>
				membership.remove({ workspace: params.workspace, membershipId: params.membershipId }).pipe(
					asSignedInPerson,
					asHttpError({
						...refusals,
						OwnerStays: BadRequest,
						ComputerUnavailable: Conflict,
						ComputerMadeMeanwhile: Conflict,
					}),
				),
			)
			.handle("leave", ({ params }) =>
				membership.leave({ workspace: params.workspace }).pipe(
					asSignedInPerson,
					asHttpError({
						...refusals,
						OwnerStays: BadRequest,
						ComputerUnavailable: Conflict,
						ComputerMadeMeanwhile: Conflict,
					}),
				),
			)
			.handle("handOverOwnership", ({ params, payload }) =>
				membership
					.handOverOwnership({ workspace: params.workspace, membershipId: payload.membershipId })
					.pipe(asSignedInPerson, asHttpError(refusals)),
			)
			.handle("invitations", ({ params }) =>
				membership
					.invitations({ workspace: params.workspace })
					.pipe(asSignedInPerson, asHttpError(refusals)),
			)
			.handle("invite", ({ params, payload }) =>
				membership
					.invite({ workspace: params.workspace, invitation: payload })
					.pipe(
						asSignedInPerson,
						asHttpError({ ...refusals, AlreadyInWorkspace: Conflict, AlreadyInvited: Conflict }),
					),
			)
			.handle("cancelInvitation", ({ params }) =>
				membership
					.cancelInvitation({ invitationId: params.invitationId })
					.pipe(asSignedInPerson, asHttpError(refusals)),
			)
			.handle("invitation", ({ params }) =>
				membership
					.invitation({ invitationId: params.invitationId })
					.pipe(
						asSignedInPerson,
						asHttpError({ ResourceHidden: NotFound, NotTheInvitee: Forbidden }),
					),
			)
			.handle("acceptInvitation", ({ params }) =>
				membership.accept({ invitationId: params.invitationId }).pipe(
					asSignedInPerson,
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
