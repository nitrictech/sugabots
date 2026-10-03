import { connectionLetters } from "@sugabots/contracts";

/**
 * A connection's mark: the service's own logo for the catalog entries we have
 * one for, and two letters on a neutral tile for anything else. A one-colour mark is
 * drawn in its brand colour on a tint of it; a mark the brand draws in several
 * colours is drawn as published, on a neutral tile so the colours read. The
 * paths are the brands' published marks as Simple Icons (CC0) carries them,
 * kept here so a settings page loads nothing from anyone else. A mark a brand
 * draws in several colours goes in `colourMarks`, as published; none of the
 * current entries needs it.
 */
/** `xs` is for a mark inline in a line of text, where a tile would tower over it. */
const sizes = {
	xs: { box: "size-4 rounded-xs", glyph: "size-2.5", letters: "text-[8px]" },
	md: { box: "size-6 rounded-[7px]", glyph: "size-3.5", letters: "text-[11px]" },
	sm: { box: "size-8 rounded-lg", glyph: "size-4", letters: "text-xs" },
	tile: { box: "size-[34px] rounded-[10px]", glyph: "size-[18px]", letters: "text-[13px]" },
	default: { box: "size-10 rounded-xl", glyph: "size-5", letters: "text-sm" },
	lg: { box: "size-11 rounded-[13px]", glyph: "size-[22px]", letters: "text-[15px]" },
} as const;

export function ConnectionMark({
	presetId,
	name,
	size = "default",
}: {
	presetId?: string;
	name: string;
	size?: keyof typeof sizes;
}) {
	const glyph = presetId ? marks[presetId] : undefined;
	const colour = presetId ? colourMarks[presetId] : undefined;
	const { box, glyph: glyphSize, letters } = sizes[size];
	if (colour) {
		return (
			<span
				aria-hidden
				className={`grid shrink-0 place-items-center border border-border-subtle bg-panel ${box}`}
			>
				<svg viewBox={colour.viewBox} className={glyphSize} aria-hidden>
					<g transform={colour.transform}>
						{colour.paths.map((path) => (
							<path key={path.d.slice(0, 40)} d={path.d} fill={path.fill} />
						))}
					</g>
				</svg>
			</span>
		);
	}
	if (glyph) {
		return (
			<span
				aria-hidden
				className={`grid shrink-0 place-items-center ${box}`}
				style={{
					backgroundColor: `color-mix(in oklab, ${glyph.hex} 14%, var(--panel))`,
					color: darkBrands.has(presetId ?? "") ? "var(--foreground)" : glyph.hex,
				}}
			>
				<svg viewBox="0 0 24 24" className={glyphSize} fill="currentColor" aria-hidden>
					<path d={glyph.d} />
				</svg>
			</span>
		);
	}
	return (
		<span
			aria-hidden
			className={`grid shrink-0 place-items-center bg-border-strong font-semibold text-foreground ${box} ${letters}`}
		>
			{connectionLetters(name)}
		</span>
	);
}

/** Brands whose colour is near black, drawn in the foreground colour so they hold up in dark mode. */
const darkBrands = new Set(["notion"]);

const marks: Record<string, { hex: string; d: string }> = {
	linear: {
		hex: "#5E6AD2",
		d: "M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z",
	},
	stripe: {
		hex: "#635BFF",
		d: "M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z",
	},
	notion: {
		hex: "#000000",
		d: "M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z",
	},
	sentry: {
		hex: "#362D59",
		d: "M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.478 15.478 0 0 1 8.53 12.811h-2.221A13.301 13.301 0 0 0 5.784 9.814l-2.926 5.06a7.65 7.65 0 0 1 4.435 5.848H2.194a.365.365 0 0 1-.298-.534l1.413-2.402a5.16 5.16 0 0 0-1.614-.913L.296 19.275a2.182 2.182 0 0 0 .812 2.999 2.24 2.24 0 0 0 1.086.288h6.983a9.322 9.322 0 0 0-3.845-8.318l1.11-1.922a11.47 11.47 0 0 1 4.95 10.24h5.915a17.242 17.242 0 0 0-7.885-15.28l2.244-3.845a.37.37 0 0 1 .504-.13c.255.14 9.75 16.708 9.928 16.9a.365.365 0 0 1-.327.543h-2.287c.029.612.029 1.223 0 1.831h2.297a2.206 2.206 0 0 0 1.922-3.31z",
	},
	jira: {
		hex: "#0052CC",
		d: "M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0Z",
	},
};

/** Marks the brand draws in several colours, as published. */
const colourMarks: Record<
	string,
	{ viewBox: string; transform?: string; paths: Array<{ d: string; fill: string }> }
> = {};
