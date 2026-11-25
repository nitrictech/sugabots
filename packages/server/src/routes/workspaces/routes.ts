import { EmailUnverified } from "@sugabots/contracts/errors/workspace";
import { BadRequest, Conflict, Forbidden } from "@sugabots/contracts/http";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { operationCaller } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, memberOnly, refusals } from "../../http/errors.ts";

/** Workspaces, who is in them and who is invited, each endpoint its operation. */
export const workspaceRoutes = HttpApiBuilder.group(ServerApi, "workspaces", (handlers) =>
	Effect.map(operationCaller, (callOperation) =>
		handlers
			.handle("list", () => callOperation("workspaces.list", {}).pipe(memberOnly))
			.handle("create", ({ payload }) =>
				callOperation("workspaces.create", payload).pipe(
					memberOnly,
					asHttpError({
						SlugTaken: Conflict,
						SlugShapedLikeUuid: BadRequest,
						TimeZoneUnknown: BadRequest,
					}),
				),
			)
			.handle("update", ({ params, payload }) =>
				callOperation("workspaces.update", { workspace: params.workspace, ...payload }).pipe(
					asHttpError({ ...refusals, SlugTaken: Conflict, SlugShapedLikeUuid: BadRequest }),
				),
			)
			.handle("timeZone", ({ params }) =>
				callOperation("workspaces.timeZone", { workspace: params.workspace }).pipe(
					asHttpError(refusals),
				),
			)
			.handle("changeTimeZone", ({ params, payload }) =>
				callOperation("workspaces.changeTimeZone", {
					workspace: params.workspace,
					timeZone: payload.timeZone,
				}).pipe(asHttpError({ ...refusals, TimeZoneUnknown: BadRequest })),
			)
			.handle("delete", ({ params }) =>
				callOperation("workspaces.delete", { workspace: params.workspace }).pipe(
					asHttpError({
						...refusals,
						ComputerUnavailable: Conflict,
						ComputerMadeMeanwhile: Conflict,
						ClaimLost: Conflict,
					}),
				),
			)
			.handle("memberships", ({ params }) =>
				callOperation("workspaces.memberships", { workspace: params.workspace }).pipe(
					asHttpError(refusals),
				),
			)
			.handle("changeRole", ({ params, payload }) =>
				callOperation("workspaces.changeRole", {
					workspace: params.workspace,
					membershipId: params.membershipId,
					role: payload.role,
				}).pipe(asHttpError(refusals)),
			)
			.handle("removeMembership", ({ params }) =>
				callOperation("workspaces.removeMembership", {
					workspace: params.workspace,
					membershipId: params.membershipId,
				}).pipe(asHttpError(departureErrors)),
			)
			.handle("handOverOwnership", ({ params, payload }) =>
				callOperation("workspaces.handOverOwnership", {
					workspace: params.workspace,
					membershipId: payload.membershipId,
				}).pipe(asHttpError(refusals)),
			)
			.handle("leave", ({ params }) =>
				callOperation("workspaces.leave", { workspace: params.workspace }).pipe(
					asHttpError({ ...departureErrors, OwnerStays: BadRequest }),
				),
			)
			.handle("invitations", ({ params }) =>
				callOperation("workspaces.invitations", { workspace: params.workspace }).pipe(
					asHttpError(refusals),
				),
			)
			.handle("invite", ({ params, payload }) =>
				callOperation("workspaces.invite", { workspace: params.workspace, ...payload }).pipe(
					asHttpError({
						...refusals,
						AlreadyInWorkspace: Conflict,
						AlreadyInvited: Conflict,
						MembershipRemovalPending: Conflict,
					}),
				),
			)
			.handle("cancelInvitation", ({ params }) =>
				callOperation("workspaces.cancelInvitation", { invitationId: params.invitationId }).pipe(
					asHttpError(refusals),
				),
			)
			.handle("invitation", ({ params }) =>
				callOperation("workspaces.invitation", { invitationId: params.invitationId }).pipe(
					emailUnverifiedAsForbidden,
					asHttpError(refusals),
				),
			)
			.handle("acceptInvitation", ({ params }) =>
				callOperation("workspaces.acceptInvitation", { invitationId: params.invitationId }).pipe(
					emailUnverifiedAsForbidden,
					asHttpError(refusals),
				),
			),
	),
);

/** What each way taking a member out of the workspace can fail means over HTTP. */
const departureErrors = {
	...refusals,
	SubscriptionInUse: Conflict,
};

/**
 * The code a client reads to tell "verify your address first" from the other
 * refusals that share its status. `isEmailUnverified` in the SDK knows it.
 */
const EMAIL_UNVERIFIED = "EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION";

/** An invitation waiting for its member to verify their address, as `Forbidden` with that code. */
const emailUnverifiedAsForbidden = <A, E, R>(
	effect: Effect.Effect<A, E | EmailUnverified, R>,
): Effect.Effect<A, Exclude<E, EmailUnverified> | Forbidden, R> =>
	Effect.catchIf<A, E | EmailUnverified, R, EmailUnverified, never, Forbidden, never>(
		effect,
		(failure): failure is EmailUnverified => failure instanceof EmailUnverified,
		(unverified) =>
			Effect.fail(new Forbidden({ message: unverified.userMessage, details: EMAIL_UNVERIFIED })),
	);
