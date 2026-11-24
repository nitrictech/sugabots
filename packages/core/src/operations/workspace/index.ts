/**
 * The workspace operations' bodies, and the layer of the services they are built
 * from. `registry.ts` gathers the operations and `layer.ts` the layers, so
 * adding an operation here touches no other file.
 *
 * `WorkspaceTimeZone` isn't in the layer: moving the workspace's zone moves its
 * automations' routines through the store that emits chat events, so it is
 * built with the chat services (see `ChatServices`), and the registry takes it
 * from there.
 */

import { Layer } from "effect";
import { Usage } from "../../accounting/usage.ts";
import { Membership } from "../../workspaces/membership/membership.ts";
import { WorkspaceSetup } from "../../workspaces/workspace-setup/workspace-setup.ts";
import { acceptInvitation } from "./accept-invitation.ts";
import { cancelInvitation } from "./cancel-invitation.ts";
import { changeRole } from "./change-role.ts";
import { changeTimeZone } from "./change-time-zone.ts";
import { completeSetup } from "./complete-setup.ts";
import { create } from "./create.ts";
import { deleteWorkspace } from "./delete.ts";
import { handOverOwnership } from "./hand-over-ownership.ts";
import { invitation } from "./invitation.ts";
import { invitations } from "./invitations.ts";
import { invite } from "./invite.ts";
import { leave } from "./leave.ts";
import { list } from "./list.ts";
import { memberships } from "./memberships.ts";
import { referralLink } from "./referral-link.ts";
import { removeMembership } from "./remove-membership.ts";
import { resetReferralLink } from "./reset-referral-link.ts";
import { timeZone } from "./time-zone.ts";
import { update } from "./update.ts";
import { usageMonth } from "./usage-month.ts";
import { workspaceAccess } from "./workspace-access.ts";

export const workspaceOperations = {
	"workspaces.list": list,
	"workspaces.create": create,
	"workspaces.update": update,
	"workspaces.timeZone": timeZone,
	"workspaces.changeTimeZone": changeTimeZone,
	"workspaces.delete": deleteWorkspace,
	"workspaces.memberships": memberships,
	"workspaces.changeRole": changeRole,
	"workspaces.removeMembership": removeMembership,
	"workspaces.handOverOwnership": handOverOwnership,
	"workspaces.leave": leave,
	"workspaces.invitations": invitations,
	"workspaces.invite": invite,
	"workspaces.cancelInvitation": cancelInvitation,
	"workspaces.invitation": invitation,
	"workspaces.acceptInvitation": acceptInvitation,
	"workspaceSetup.complete": completeSetup,
	"referrals.link": referralLink,
	"referrals.resetLink": resetReferralLink,
	"usage.month": usageMonth,
	"system.workspaceAccess": workspaceAccess,
};

export const workspaceLayer = Layer.mergeAll(Membership.layer, WorkspaceSetup.layer, Usage.layer);
