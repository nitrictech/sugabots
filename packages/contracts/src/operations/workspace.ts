/**
 * The workspace operations' contracts, each with its decisions in the exposure manifest.
 * `index.ts` spreads them, so adding an operation here touches no other file.
 */

import { Schema } from "effect";
import { currentUserSchema, memberNameSchema } from "../api.ts";
import { ClaimLost, ComputerMadeMeanwhile, ComputerUnavailable } from "../errors/computers.ts";
import {
	ActionForbidden,
	ApprovalNeeded,
	ApprovalRefused,
	ResourceHidden,
} from "../errors/proofs.ts";
import {
	AlreadyInvited,
	AlreadyInWorkspace,
	EmailUnverified,
	MembershipRemovalPending,
	NoModelChosen,
	NotReadyToFinish,
	OwnerStays,
	ReferralsOff,
	SlugShapedLikeUuid,
	SlugTaken,
	SubscriptionInUse,
	TimeZoneUnknown,
} from "../errors/workspace.ts";
import {
	acceptedInvitationSchema,
	invitationPreviewSchema,
	membershipDepartureSchema,
	membershipSchema,
	newWorkspaceInvitationSchema,
	newWorkspaceSchema,
	ownershipHandOverSchema,
	roleChangeSchema,
	workspaceDetailsSchema,
	workspaceInvitationSchema,
	workspaceSchema,
	workspaceTimeZoneChangeSchema,
	workspaceTimeZoneSchema,
} from "../membership.ts";
import { referralLinkSchema, resetReferralLinkSchema } from "../referrals.ts";
import { usageQuerySchema, workspaceUsageSchema } from "../usage.ts";
import { uuidSchema } from "../uuid.ts";
import { workspaceGuideSchema } from "../workspace-guide.ts";
import { completeWorkspaceSetupSchema } from "../workspace-setup.ts";
import { workspaceAccessSchema, workspaceIdOrSlugSchema } from "../workspaces.ts";
import { OperationContract } from "./operation.ts";

/** How an operation only a member signed in may call refuses anyone else. */
const memberRefusals = [ActionForbidden] as const;

/** How an operation that proves what it may do in a workspace refuses. */
const workspaceRefusals = [ResourceHidden, ActionForbidden] as const;

/** How taking a member out of the workspace can fail besides its refusals. */

/** A workspace, by its id or its slug. */
const aWorkspace = Schema.Struct({ workspace: workspaceIdOrSlugSchema });

/** A membership of a workspace, by its id. */
const aMembership = Schema.Struct({ workspace: workspaceIdOrSlugSchema, membershipId: uuidSchema });

/** An invitation, by its id. */
const anInvitation = Schema.Struct({ invitationId: uuidSchema });

/** Nothing: the operation acts on the member signed in. */
const nothing = Schema.Struct({});

/** Held back: it changes who is in the workspace, which a bot may do only in member bounds. */
const changesWhoIsIn = {
	kind: "heldBack",
	reason:
		"It changes who is in the workspace, which a bot may do only in member bounds, and no tool does it yet.",
} as const;

/** Held back: it manages the workspace, which a bot may do only in member bounds. */
const managesWorkspace = {
	kind: "heldBack",
	reason:
		"It manages the workspace, which a bot may do only in member bounds, and no tool does it yet.",
} as const;

/** Held back: only the member an invitation is addressed to answers it, before they are in its workspace. */
const answersInvitation = {
	kind: "heldBack",
	reason:
		"Only the member an invitation is addressed to answers it, signed in, before they are in the workspace any bot of theirs works in.",
} as const;

/** Held back: a referral link is its member's own, to send from the web app. */
const ownReferralLink = {
	kind: "heldBack",
	reason: "A member's referral link is their own, to send from the web app; no tool needs it.",
} as const;

export const workspaceContracts = {
	"workspaces.guide": OperationContract.make("workspaces.guide", {
		description:
			"See the workspace as your member does: its projects, the bots they can reach with what each is for, and what is waiting on them (approvals, unread mentions, failing automations), each with its link and id.",
		input: nothing,
		output: workspaceGuideSchema,
		errors: [...workspaceRefusals, ApprovalNeeded, ApprovalRefused],
		changes: false,
		http: {
			kind: "heldBack",
			reason:
				"It is a Personal Assistant's view of its member's workspace; the web app shows the same through the projects, bots and chat-reads operations.",
		},
		botLoop: {
			kind: "offered",
			tool: "workspace_guide",
			offeredIn: "memberBounds",
			approval: { kind: "never" },
			personalBotAsks: false,
		},
	}),
	"workspaces.list": OperationContract.make("workspaces.list", {
		description: "List the workspaces you are in, in the order you joined them.",
		input: nothing,
		output: Schema.Array(workspaceSchema),
		errors: memberRefusals,
		changes: false,
		http: { kind: "offered", method: "GET", path: "/workspaces" },
		botLoop: {
			kind: "heldBack",
			reason:
				"A bot works in one workspace; only a member signed in lists the workspaces they are in.",
		},
	}),
	"workspaces.create": OperationContract.make("workspaces.create", {
		description:
			"Make a workspace, owned by you, with its system bots, built-in providers and your Personal Assistant.",
		input: newWorkspaceSchema,
		output: workspaceSchema,
		errors: [...memberRefusals, SlugTaken, SlugShapedLikeUuid, TimeZoneUnknown],
		changes: true,
		http: { kind: "offered", method: "POST", path: "/workspaces", status: 201 },
		botLoop: {
			kind: "heldBack",
			reason:
				"Making a workspace is a member's own step in the web app, outside any workspace a bot works in.",
		},
	}),
	"workspaces.update": OperationContract.make("workspaces.update", {
		description: "Rename the workspace, or change its address.",
		input: Schema.Struct({ workspace: workspaceIdOrSlugSchema, ...workspaceDetailsSchema.fields }),
		output: workspaceSchema,
		errors: [...workspaceRefusals, SlugTaken, SlugShapedLikeUuid],
		changes: true,
		http: { kind: "offered", method: "PATCH", path: "/workspaces/:workspace" },
		botLoop: managesWorkspace,
	}),
	"workspaces.timeZone": OperationContract.make("workspaces.timeZone", {
		description:
			"Read the workspace's time zone, and how many automations have a routine in it, which move with it.",
		input: aWorkspace,
		output: workspaceTimeZoneSchema,
		errors: workspaceRefusals,
		changes: false,
		http: { kind: "offered", method: "GET", path: "/workspaces/:workspace/time-zone" },
		botLoop: managesWorkspace,
	}),
	"workspaces.changeTimeZone": OperationContract.make("workspaces.changeTimeZone", {
		description:
			"Move the workspace to another time zone, with its automations' routines in its old one.",
		input: Schema.Struct({
			workspace: workspaceIdOrSlugSchema,
			...workspaceTimeZoneChangeSchema.fields,
		}),
		output: Schema.Void,
		errors: [...workspaceRefusals, TimeZoneUnknown],
		changes: true,
		http: { kind: "offered", method: "PUT", path: "/workspaces/:workspace/time-zone" },
		botLoop: managesWorkspace,
	}),
	"workspaces.delete": OperationContract.make("workspaces.delete", {
		description:
			"Delete the workspace, with its projects, bots, chats and providers. A recorded deletion resumes when the computer provider is reachable.",
		input: aWorkspace,
		output: Schema.Void,
		errors: [...workspaceRefusals, ComputerUnavailable, ComputerMadeMeanwhile, ClaimLost],
		changes: true,
		http: { kind: "offered", method: "DELETE", path: "/workspaces/:workspace" },
		botLoop: {
			kind: "heldBack",
			reason:
				"Deleting a workspace deletes everything in it, every bot included; its owner does it in the web app.",
		},
	}),
	"workspaces.memberships": OperationContract.make("workspaces.memberships", {
		description: "List who is in the workspace, with their roles, in the order they joined.",
		input: aWorkspace,
		output: Schema.Array(membershipSchema),
		errors: workspaceRefusals,
		changes: false,
		http: { kind: "offered", method: "GET", path: "/workspaces/:workspace/memberships" },
		botLoop: {
			kind: "heldBack",
			reason:
				"No tool lists the workspace's members; offering one waits for tools to become operations.",
		},
	}),
	"workspaces.changeRole": OperationContract.make("workspaces.changeRole", {
		description:
			"Change a member's role. Only the owner makes or unmakes admins, and nobody changes the owner's.",
		input: Schema.Struct({ ...aMembership.fields, ...roleChangeSchema.fields }),
		output: Schema.Void,
		errors: workspaceRefusals,
		changes: true,
		http: {
			kind: "offered",
			method: "PATCH",
			path: "/workspaces/:workspace/memberships/:membershipId",
		},
		botLoop: changesWhoIsIn,
	}),
	"workspaces.removeMembership": OperationContract.make("workspaces.removeMembership", {
		description:
			"Remove a member from the workspace immediately, revoke their sessions and connector sign-ins, and queue any remaining cleanup of their Personal Assistants' computers. Only the owner removes an admin, and nobody removes the owner.",
		input: aMembership,
		output: membershipDepartureSchema,
		errors: [...workspaceRefusals, SubscriptionInUse],
		changes: true,
		http: {
			kind: "offered",
			method: "DELETE",
			path: "/workspaces/:workspace/memberships/:membershipId",
		},
		botLoop: changesWhoIsIn,
	}),
	"workspaces.handOverOwnership": OperationContract.make("workspaces.handOverOwnership", {
		description:
			"Hand the workspace over to another member in it, who becomes its owner; you become an admin.",
		input: Schema.Struct({
			workspace: workspaceIdOrSlugSchema,
			...ownershipHandOverSchema.fields,
		}),
		output: Schema.Void,
		errors: workspaceRefusals,
		changes: true,
		http: { kind: "offered", method: "PUT", path: "/workspaces/:workspace/owner" },
		botLoop: changesWhoIsIn,
	}),
	"workspaces.leave": OperationContract.make("workspaces.leave", {
		description:
			"Leave the workspace immediately. This ends your sessions and connector sign-ins and queues any remaining cleanup of your Personal Assistants' computers. The owner stays until they hand it over.",
		input: aWorkspace,
		output: membershipDepartureSchema,
		errors: [...workspaceRefusals, OwnerStays, SubscriptionInUse],
		changes: true,
		http: { kind: "offered", method: "POST", path: "/workspaces/:workspace/leave" },
		botLoop: changesWhoIsIn,
	}),
	"workspaces.invitations": OperationContract.make("workspaces.invitations", {
		description: "List the invitations to the workspace still waiting to be accepted.",
		input: aWorkspace,
		output: Schema.Array(workspaceInvitationSchema),
		errors: workspaceRefusals,
		changes: false,
		http: { kind: "offered", method: "GET", path: "/workspaces/:workspace/invitations" },
		botLoop: {
			kind: "heldBack",
			reason:
				"No tool lists the workspace's invitations; offering one waits for tools to become operations.",
		},
	}),
	"workspaces.invite": OperationContract.make("workspaces.invite", {
		description:
			"Email someone an invitation to the workspace with a role, or send a pending one again.",
		input: Schema.Struct({
			workspace: workspaceIdOrSlugSchema,
			...newWorkspaceInvitationSchema.fields,
		}),
		output: workspaceInvitationSchema,
		errors: [...workspaceRefusals, AlreadyInWorkspace, AlreadyInvited, MembershipRemovalPending],
		changes: true,
		http: {
			kind: "offered",
			method: "POST",
			path: "/workspaces/:workspace/invitations",
			status: 201,
		},
		botLoop: changesWhoIsIn,
	}),
	"workspaces.cancelInvitation": OperationContract.make("workspaces.cancelInvitation", {
		description: "Cancel a pending invitation, so its link stops working.",
		input: anInvitation,
		output: Schema.Void,
		errors: workspaceRefusals,
		changes: true,
		http: { kind: "offered", method: "DELETE", path: "/invitations/:invitationId" },
		botLoop: changesWhoIsIn,
	}),
	"workspaces.invitation": OperationContract.make("workspaces.invitation", {
		description:
			"Read an invitation sent to you: one still to accept, or one you accepted, whose link leads back into its workspace.",
		input: anInvitation,
		output: invitationPreviewSchema,
		errors: [...workspaceRefusals, EmailUnverified],
		changes: false,
		http: { kind: "offered", method: "GET", path: "/invitations/:invitationId" },
		botLoop: answersInvitation,
	}),
	"workspaces.acceptInvitation": OperationContract.make("workspaces.acceptInvitation", {
		description:
			"Accept an invitation sent to you, joining its workspace with your Personal Assistant. Accepting again changes nothing.",
		input: anInvitation,
		output: acceptedInvitationSchema,
		errors: [...workspaceRefusals, EmailUnverified],
		changes: true,
		http: { kind: "offered", method: "POST", path: "/invitations/:invitationId/accept" },
		botLoop: answersInvitation,
	}),
	"workspaceSetup.complete": OperationContract.make("workspaceSetup.complete", {
		description:
			"Finish setting up the workspace with the first bot you made there, whose model becomes the workspace's default and every system bot's.",
		input: completeWorkspaceSetupSchema,
		output: Schema.Void,
		errors: [...workspaceRefusals, NotReadyToFinish, NoModelChosen],
		changes: true,
		http: { kind: "offered", method: "POST", path: "/workspace-setup/complete" },
		botLoop: {
			kind: "heldBack",
			reason:
				"Finishing a workspace's setup is the last step of the web app's setup flow, taken by the member setting it up.",
		},
	}),
	"referrals.link": OperationContract.make("referrals.link", {
		description:
			"Read the link you can send someone to let them sign up, or none when sign-up isn't by referral.",
		input: nothing,
		output: referralLinkSchema,
		errors: memberRefusals,
		changes: false,
		http: { kind: "offered", method: "GET", path: "/referral-link" },
		botLoop: ownReferralLink,
	}),
	"referrals.resetLink": OperationContract.make("referrals.resetLink", {
		description: "Stop your referral link working, and make the one that replaces it.",
		input: nothing,
		output: resetReferralLinkSchema,
		errors: [...memberRefusals, ReferralsOff],
		changes: true,
		http: { kind: "offered", method: "POST", path: "/referral-link/reset" },
		botLoop: ownReferralLink,
	}),
	"usage.month": OperationContract.make("usage.month", {
		description:
			"Read one month of what the workspace's models cost, by day, bot and model, in its time zone.",
		input: Schema.Struct({ workspace: workspaceIdOrSlugSchema, ...usageQuerySchema.fields }),
		output: workspaceUsageSchema,
		errors: workspaceRefusals,
		changes: false,
		http: { kind: "offered", method: "GET", path: "/workspaces/:workspace/usage" },
		botLoop: {
			kind: "heldBack",
			reason:
				"No tool reads the workspace's usage, which shows every bot's; offering one, in member bounds, waits for tools to become operations.",
		},
	}),
	"system.workspaceAccess": OperationContract.make("system.workspaceAccess", {
		description: "Read your role in the workspace, and what it lets you do there.",
		input: aWorkspace,
		output: workspaceAccessSchema,
		errors: workspaceRefusals,
		changes: false,
		http: { kind: "offered", method: "GET", path: "/workspaces/:workspace/me" },
		botLoop: {
			kind: "heldBack",
			reason:
				"It tells the web app which controls to draw; a bot's tools prove what they may do as they run.",
		},
	}),
	"system.rename": OperationContract.make("system.rename", {
		description:
			"Change your own name, which other members see in every workspace you are in, and which makes your handle.",
		input: Schema.Struct({ name: memberNameSchema }),
		output: currentUserSchema,
		errors: [ActionForbidden],
		changes: true,
		http: {
			kind: "ownEndpoint",
			reason: "Renaming renews the session's cookie, which caches the member's name.",
		},
		botLoop: {
			kind: "heldBack",
			reason: "A member's name is theirs to change; a bot acting for them never renames them.",
		},
	}),
} as const;
