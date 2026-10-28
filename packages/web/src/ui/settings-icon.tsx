import type { SVGProps } from "react";

/**
 * The one mark for settings everywhere in the app: two sliders, drawn as the
 * design draws them. It takes lucide's `size` and `strokeWidth`, so it sits
 * beside lucide icons, and is hidden from screen readers like them.
 */
export function SettingsIcon({
	size = 16,
	strokeWidth = 1.75,
	...props
}: SVGProps<SVGSVGElement> & { size?: number }) {
	return (
		<svg
			aria-hidden
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={strokeWidth}
			strokeLinecap="round"
			strokeLinejoin="round"
			{...props}
		>
			<path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
			<circle cx="16" cy="7" r="2" />
			<circle cx="10" cy="17" r="2" />
		</svg>
	);
}
