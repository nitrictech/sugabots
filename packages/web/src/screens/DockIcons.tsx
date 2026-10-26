import { useId } from "react";

/*
 * The desktop dock's app icons, flat and full-colour like a Linux desktop's.
 * Apart from the browser's, which is Chromium's own, they are drawn here
 * rather than taken from an icon theme: the themes that look like this are
 * GPL, and this app is MIT.
 */

interface IconProps {
	size: number;
}

/**
 * The browser, which is Chromium: its own logo, from the Chromium source
 * (chrome/app/theme/chromium/product_logo.svg), under Chromium's BSD licence.
 */
export function BrowserIcon({ size }: IconProps) {
	return (
		<svg aria-hidden width={size} height={size} viewBox="-14 -14 284 284" fill="none">
			<path
				d="M128 191.995c35.346 0 64-28.654 64-64 0-35.347-28.654-64-64-64-35.346 0-64 28.654-64 64 0 35.346 28.654 64 64 64Z"
				fill="#fff"
			/>
			<path
				d="M96.01 183.41a63.681 63.681 0 0 1-23.42-23.43l-.007.004-55.425-96a128.027 128.027 0 0 0 110.841 192.018l55.436-96.018a63.985 63.985 0 0 1-16.465 18.775 64.007 64.007 0 0 1-70.96 4.651Z"
				fill="#669DF6"
			/>
			<path
				d="M191.991 127.984a63.683 63.683 0 0 1-8.581 31.996l.007.004-55.426 96a128.029 128.029 0 0 0 110.872-192H127.991a64 64 0 0 1 64 64Z"
				fill="#AECBFA"
			/>
			<path
				d="M128 180c28.719 0 52-23.281 52-52s-23.281-52-52-52-52 23.281-52 52 23.281 52 52 52Z"
				fill="#1A73E8"
			/>
			<path
				d="M95.99 72.59a63.684 63.684 0 0 1 32.001-8.566v-.008h110.851A128.035 128.035 0 0 0 127.991.026 128.028 128.028 0 0 0 17.13 63.999l55.436 96.018a64.003 64.003 0 0 1 4.65-70.961A64 64 0 0 1 95.991 72.59Z"
				fill="#1967D2"
			/>
		</svg>
	);
}

/** A terminal: a prompt and cursor on a slate tile. */
export function TerminalIcon({ size }: IconProps) {
	const shade = useId();
	return (
		<svg aria-hidden width={size} height={size} viewBox="0 0 48 48">
			<defs>
				<linearGradient id={shade} x1="0" y1="0" x2="0" y2="1">
					<stop offset="0" stopColor="#7b8089" />
					<stop offset="1" stopColor="#5c616a" />
				</linearGradient>
			</defs>
			<rect x="4" y="4" width="40" height="40" rx="8" fill={`url(#${shade})`} />
			<path
				d="M13 18l7 6-7 6"
				fill="none"
				stroke="#ffffff"
				strokeWidth="3"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<path d="M23 32h11" stroke="#ffffff" strokeWidth="3" strokeLinecap="round" />
		</svg>
	);
}

/** A file manager: a light blue folder with its tab behind. */
export function FilesIcon({ size }: IconProps) {
	return (
		<svg aria-hidden width={size} height={size} viewBox="0 0 48 48">
			<path d="M4 11a4 4 0 0 1 4-4h11l4 4h17a4 4 0 0 1 4 4v4H4z" fill="#0b9bd8" />
			<rect x="4" y="15" width="40" height="28" rx="4" fill="#3cc4f2" />
			<rect x="4" y="15" width="40" height="5" rx="2.5" fill="#6dd5f7" />
		</svg>
	);
}

/** Any other app, as an agent starts them: a window on a violet tile. */
export function AppIcon({ size }: IconProps) {
	const shade = useId();
	return (
		<svg aria-hidden width={size} height={size} viewBox="0 0 48 48">
			<defs>
				<linearGradient id={shade} x1="0" y1="0" x2="0" y2="1">
					<stop offset="0" stopColor="#a78bfa" />
					<stop offset="1" stopColor="#7c3aed" />
				</linearGradient>
			</defs>
			<rect x="4" y="4" width="40" height="40" rx="8" fill={`url(#${shade})`} />
			<rect x="11" y="13" width="26" height="22" rx="3" fill="#ffffff" />
			<rect x="11" y="13" width="26" height="6" rx="3" fill="#ede9fe" />
			<circle cx="15" cy="16" r="1.2" fill="#7c3aed" />
			<circle cx="19" cy="16" r="1.2" fill="#7c3aed" />
		</svg>
	);
}
