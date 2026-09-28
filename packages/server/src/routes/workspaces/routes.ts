import { BadRequest, Conflict, CurrentUser, Forbidden, NotFound } from "@sugabots/contracts/http";
import type { Membership } from "@sugabots/core/workspaces/membership/membership";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ServerApi } from "../../http/api.ts";
import { asHttpError } from "../../http/errors.ts";

export interface WorkspaceRoutesOptions {
	membership: Membership.Interface;
}

/** `Membership` decides who may do what; these map its refusals to HTTP. */
export function workspaceRoutes({ membership }: WorkspaceRoutesOptions) {
	return HttpApiBuilder.group(ServerApi, "workspaces", (handlers) =>
		handlers
			.handle("list", () =>
				Effect.flatMap(CurrentUser, (user) => membership.workspaces({ userId: user.id })),
			)
			.handle("create", ({ payload }) =>
				Effect.flatMap(CurrentUser, (user) =>
					membership.create({ userId: user.id, details: payload }),
				).pipe(asHttpError({ SlugTaken: Conflict, SlugShapedLikeUuid: BadRequest })),
			)
			.handle("update", ({ params, payload }) =>
				Effect.flatMap(CurrentUser, (user) =>
					membership.update({ userId: user.id, workspace: params.workspace, details: payload }),
				).pipe(asHttpError({ ...denied, SlugTaken: Conflict, SlugShapedLikeUuid: BadRequest })),
			)
			.handle("members", ({ params }) =>
				Effect.flatMap(CurrentUser, (user) =>
					membership.members({ userId: user.id, workspace: params.workspace }),
				).pipe(asHttpError(denied)),
			)
			.handle("updateMember", ({ params, payload }) =>
				Effect.flatMap(CurrentUser, (user) =>
					membership.changeRole({
						userId: user.id,
						workspace: params.workspace,
						memberId: params.memberId,
						role: payload.role,
					}),
				).pipe(asHttpError({ ...denied, LastAdministrator: BadRequest })),
			)
			.handle("removeMember", ({ params }) =>
				Effect.flatMap(CurrentUser, (user) =>
					membership.remove({
						userId: user.id,
						workspace: params.workspace,
						memberId: params.memberId,
					}),
				).pipe(asHttpError({ ...denied, LastAdministrator: BadRequest })),
			)
			.handle("leave", ({ params }) =>
				Effect.flatMap(CurrentUser, (user) =>
					membership.leave({ userId: user.id, workspace: params.workspace }),
				).pipe(asHttpError({ ...denied, LastAdministrator: BadRequest })),
			)
			.handle("invitations", ({ params }) =>
				Effect.flatMap(CurrentUser, (user) =>
					membership.invitations({ userId: user.id, workspace: params.workspace }),
				).pipe(asHttpError(denied)),
			)
			.handle("invite", ({ params, payload }) =>
				Effect.flatMap(CurrentUser, (user) =>
					membership.invite({ userId: user.id, workspace: params.workspace, invitation: payload }),
				).pipe(asHttpError({ ...denied, AlreadyMember: Conflict, AlreadyInvited: Conflict })),
			)
			.handle("cancelInvitation", ({ params }) =>
				Effect.flatMap(CurrentUser, (user) =>
					membership.cancelInvitation({ userId: user.id, invitationId: params.invitationId }),
				).pipe(asHttpError(denied)),
			)
			.handle("invitation", ({ params }) =>
				Effect.flatMap(CurrentUser, (user) =>
					membership.invitation({ userId: user.id, invitationId: params.invitationId }),
				).pipe(asHttpError({ ResourceHidden: NotFound, NotTheInvitee: Forbidden })),
			)
			.handle("acceptInvitation", ({ params }) =>
				Effect.flatMap(CurrentUser, (user) =>
					membership.accept({ userId: user.id, invitationId: params.invitationId }),
				).pipe(
					Effect.catchTag("EmailUnverified", (unverified) =>
						Effect.fail(
							new Forbidden({ message: unverified.userMessage, details: EMAIL_UNVERIFIED }),
						),
					),
					asHttpError({ ResourceHidden: NotFound, NotTheInvitee: Forbidden }),
				),
			),
	);
}

/**
 * The code a client reads to tell "verify your address first" from the other
 * refusals that share its status. `isEmailUnverified` in the SDK knows it.
 */
const EMAIL_UNVERIFIED = "EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION";

const denied = { ResourceHidden: NotFound, ActionForbidden: Forbidden };
