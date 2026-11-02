import { cn } from "cn";
import type { CSSProperties, ReactElement } from "react";
import { DetailTooltip } from "@/ui/tooltip.tsx";

/**
 * Who sees into a Personal pod. In the app that is its owner alone: no role,
 * admin included, reaches another person's Personal pod.
 */
export const PERSONAL_POD_PRIVACY = "Only you can see into this pod.";

const PERSONAL_POD_PRIVACY_DETAIL = "Nobody else can, workspace admins included.";

/** Both sentences, for a screen reader, which is never shown {@link OnlyYou}'s tooltip. */
export const PERSONAL_POD_PRIVACY_IN_FULL = `${PERSONAL_POD_PRIVACY} ${PERSONAL_POD_PRIVACY_DETAIL}`;

/** The short form, beside a Personal pod's or its bot's name. */
export const ONLY_YOU = "Only you";

/**
 * A Personal pod's "Only you", which says in full under the pointer that
 * nobody else sees into it, admins included. The tooltip is drawn only for
 * sight, so where the full sentence matters to a screen reader, point the
 * nearest control at {@link PERSONAL_POD_PRIVACY_IN_FULL}.
 */
export function OnlyYou({
	lock = false,
	side = "right",
	className,
}: {
	/** Whether a lock comes before it, where nothing beside it is locked already. */
	lock?: boolean;
	side?: "bottom" | "right";
	className?: string;
}) {
	return (
		<DetailTooltip
			title={PERSONAL_POD_PRIVACY}
			description={PERSONAL_POD_PRIVACY_DETAIL}
			side={side}
		>
			<span className={cn("inline-flex shrink-0 items-center gap-1", className)}>
				{lock && <LockGlyph size={8} />}
				{ONLY_YOU}
			</span>
		</DetailTooltip>
	);
}

/** A Personal pod's mark, `children`, with a lock over a notch in its top right corner. */
export function Locked({
	lockSize,
	className,
	children,
}: {
	lockSize: LockSize;
	className?: string;
	children: ReactElement;
}) {
	// How far the lock reaches past the mark's corner: an eighth of it, a whole pixel at either size.
	const overhang = lockSize / 8;
	return (
		<span
			aria-hidden
			className={cn("relative grid shrink-0 [&>:first-child]:lock-notch", className)}
			style={
				{ "--lock-size": `${lockSize}px`, "--lock-overhang": `${overhang}px` } as CSSProperties
			}
		>
			{children}
			<LockGlyph
				size={lockSize}
				className="absolute text-foreground"
				style={{ top: -overhang, right: -overhang }}
			/>
		</span>
	);
}

/** Whole multiples of the lock's 8px grid, so its edges land on pixels. */
type LockSize = 8 | 16;

/** A solid padlock, drawn on an 8px grid to stay sharp at the small sizes it is shown at. */
export function LockGlyph({
	size,
	className,
	style,
}: {
	size: LockSize;
	className?: string;
	style?: CSSProperties;
}) {
	return (
		<svg
			aria-hidden
			width={size}
			height={size}
			viewBox="0 0 8 8"
			className={className}
			style={style}
		>
			<path d="M2.5 4V2.5a1.5 1.5 0 0 1 3 0V4" fill="none" stroke="currentColor" />
			<rect x="1" y="4" width="6" height="4" rx="1" fill="currentColor" />
		</svg>
	);
}
