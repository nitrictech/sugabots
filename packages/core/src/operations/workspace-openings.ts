/**
 * The opening most operations on a workspace's own settings share: the
 * workspace its input names, by id or slug, named with the principal, and
 * proved to be one the principal may manage, or may read. The operation's
 * body gets the proof and goes on from there, so every proof it adds is
 * still written in the operation.
 *
 * ```ts
 * managingWorkspace(principal, input.workspace, (canManage) =>
 * 	timeZones.change(canManage, input.timeZone),
 * );
 * ```
 *
 * Each opening is written out with its own prover and no cast, so the
 * compiler checks that the body is handed the proof it asks for.
 */

import type { ActionForbidden, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { Effect } from "effect";
import type { Principal } from "../principal.ts";
import { proveInWorkspace } from "../proofs/in-workspace.ts";
import { type Named, named } from "../proofs/proof.ts";
import {
	type CanManageWorkspace,
	type CanReadWorkspace,
	proveCanManageWorkspace,
	proveCanReadWorkspace,
} from "../proofs/workspace-permissions.ts";
import { workspaceIdOf } from "../workspaces/workspace-reference.ts";

/** How an opening refuses: the workspace is hidden from the principal, or not theirs to manage or read. */
type Refusal = ResourceHidden | ActionForbidden;

/** What finding the workspace a reference names needs. */
type LookupServices = Effect.Services<ReturnType<typeof workspaceIdOf>>;

/**
 * Proves the principal may manage the workspace `reference` names, and runs
 * `body` with the proof. Given `other`, such as a provider's id in that
 * workspace, it is named with them, and `body` gets it too.
 */
export function managingWorkspace<Success, Failure, Services>(
	principal: Principal,
	reference: string,
	body: <P, W>(canManage: CanManageWorkspace<P, W>) => Effect.Effect<Success, Failure, Services>,
): Effect.Effect<Success, Failure | Refusal, Services | LookupServices>;
export function managingWorkspace<Other, Success, Failure, Services>(
	principal: Principal,
	reference: string,
	other: Other,
	body: <P, W, O>(
		canManage: CanManageWorkspace<P, W>,
		other: Named<O, Other>,
	) => Effect.Effect<Success, Failure, Services>,
): Effect.Effect<Success, Failure | Refusal, Services | LookupServices>;
export function managingWorkspace<Other, Success, Failure, Services>(
	principal: Principal,
	reference: string,
	...otherAndBody:
		| readonly [
				body: <P, W>(
					canManage: CanManageWorkspace<P, W>,
				) => Effect.Effect<Success, Failure, Services>,
		  ]
		| readonly [
				other: Other,
				body: <P, W, O>(
					canManage: CanManageWorkspace<P, W>,
					other: Named<O, Other>,
				) => Effect.Effect<Success, Failure, Services>,
		  ]
): Effect.Effect<Success, Failure | Refusal, Services | LookupServices> {
	return Effect.flatMap(workspaceIdOf(reference), (workspaceId) => {
		if (otherAndBody.length === 1) {
			const [body] = otherAndBody;
			return named(principal, workspaceId, (principal, workspace) =>
				Effect.flatMap(provingManagement(principal, workspace), body),
			);
		}
		const [other, body] = otherAndBody;
		return named(principal, workspaceId, other, (principal, workspace, other) =>
			Effect.flatMap(provingManagement(principal, workspace), (canManage) =>
				body(canManage, other),
			),
		);
	});
}

/**
 * Proves the principal may read the workspace `reference` names, as its
 * directory shows it, and runs `body` with the proof. Given `other`, it is
 * named with them, and `body` gets it too.
 */
export function readingWorkspace<Success, Failure, Services>(
	principal: Principal,
	reference: string,
	body: <P, W>(canRead: CanReadWorkspace<P, W>) => Effect.Effect<Success, Failure, Services>,
): Effect.Effect<Success, Failure | Refusal, Services | LookupServices>;
export function readingWorkspace<Other, Success, Failure, Services>(
	principal: Principal,
	reference: string,
	other: Other,
	body: <P, W, O>(
		canRead: CanReadWorkspace<P, W>,
		other: Named<O, Other>,
	) => Effect.Effect<Success, Failure, Services>,
): Effect.Effect<Success, Failure | Refusal, Services | LookupServices>;
export function readingWorkspace<Other, Success, Failure, Services>(
	principal: Principal,
	reference: string,
	...otherAndBody:
		| readonly [
				body: <P, W>(canRead: CanReadWorkspace<P, W>) => Effect.Effect<Success, Failure, Services>,
		  ]
		| readonly [
				other: Other,
				body: <P, W, O>(
					canRead: CanReadWorkspace<P, W>,
					other: Named<O, Other>,
				) => Effect.Effect<Success, Failure, Services>,
		  ]
): Effect.Effect<Success, Failure | Refusal, Services | LookupServices> {
	return Effect.flatMap(workspaceIdOf(reference), (workspaceId) => {
		if (otherAndBody.length === 1) {
			const [body] = otherAndBody;
			return named(principal, workspaceId, (principal, workspace) =>
				Effect.flatMap(provingReading(principal, workspace), body),
			);
		}
		const [other, body] = otherAndBody;
		return named(principal, workspaceId, other, (principal, workspace, other) =>
			Effect.flatMap(provingReading(principal, workspace), (canRead) => body(canRead, other)),
		);
	});
}

/** That `principal` is in `workspace` and may manage it. */
const provingManagement = <P, W>(principal: Named<P, Principal>, workspace: Named<W, string>) =>
	Effect.flatMap(proveInWorkspace(principal, workspace), proveCanManageWorkspace);

/** That `principal` is in `workspace` and may read it. */
const provingReading = <P, W>(principal: Named<P, Principal>, workspace: Named<W, string>) =>
	Effect.flatMap(proveInWorkspace(principal, workspace), proveCanReadWorkspace);
