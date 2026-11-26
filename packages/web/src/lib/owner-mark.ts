import type { CSSProperties } from "react";

/** How big a bot's face and a project's tile are, in the sidebar's rows and on the icon rail alike, in pixels. */
export const OWNER_MARK_SIZE_PX = 22;

/**
 * The view transition name of a bot's face or a project's tile, the same in
 * the sidebar's rows and on the icon rail, so opening a bot or a project
 * carries its mark from one to the other. Its class, `owner-mark`, is how
 * app.css styles every mark's transition at once.
 */
export function ownerMarkTransition(ownerId: string): CSSProperties {
	return { viewTransitionName: `owner-mark-${ownerId}`, viewTransitionClass: "owner-mark" };
}
