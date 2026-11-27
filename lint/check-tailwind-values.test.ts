import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { tailwindValueViolations } from "./check-tailwind-values.ts";

function fixture(name: string) {
	return readFileSync(new URL(`./fixtures/tailwind-values/${name}.tsx`, import.meta.url), "utf8");
}

it("finds fixed Tailwind values in decoded class tokens", () => {
	expect(tailwindValueViolations("fixed.tsx", fixture("fixed")).map(({ token }) => token)).toEqual([
		"hover:bg-red-500",
		"bg-red-500/50",
		"!bg-red-500",
		"sm:focus-visible:bg-red-500/50!",
		"[@media(hover:none)]:text-blue-600",
		"[&[data-label=']']]:border-rose-400",
		"[--brand-tone:blue]",
		"[color:var(--brand)]",
		"md:[--brand-tone:blue]",
		"w-[theme(spacing[2.5])]",
		"text-sm/[1.4]",
		"p-[12px]",
		"md:gap-[7px]",
		"w-[16px]",
	]);
});

it("allows semantic tokens and selector variants", () => {
	expect(tailwindValueViolations("standard.tsx", fixture("standard"))).toEqual([]);
});

it("allows the media surround while checking other colours in the same file", () => {
	const file = "packages/web/src/screens/MessageFiles.tsx";
	expect(
		tailwindValueViolations(file, '<div className="max-md:bg-black hover:bg-black" />'),
	).toEqual([{ token: "hover:bg-black", line: 1 }]);
});

it("finds animation utilities from plugins that the web stylesheet does not load", () => {
	const source =
		'"motion-safe:animate-in data-closed:animate-out motion-safe:fade-in-0 focus-visible:zoom-in-50 hover:slide-in-from-bottom-2 motion-safe:animate-copy-confirmation"';
	const tokens = (file: string) => tailwindValueViolations(file, source).map(({ token }) => token);
	expect(tokens("packages/web/src/control.tsx")).toEqual([
		"motion-safe:animate-in",
		"data-closed:animate-out",
		"motion-safe:fade-in-0",
		"focus-visible:zoom-in-50",
		"hover:slide-in-from-bottom-2",
	]);
	expect(tokens("packages/website/src/control.tsx")).toEqual([]);
});

it("finds spacing, sizes and line heights off the default theme's steps", () => {
	const source =
		'"px-2.75 size-7.25 max-md:py-1.25 mt-13 -mt-13 w-70 max-w-105 px-2.5 size-7 mt-12 w-72 w-1/3 max-w-md w-px top-1/2 leading-5.5 leading-13 leading-6 leading-none"';
	expect(tailwindValueViolations("spacing.tsx", source).map(({ token }) => token)).toEqual([
		"px-2.75",
		"size-7.25",
		"max-md:py-1.25",
		"mt-13",
		"-mt-13",
		"w-70",
		"max-w-105",
		"leading-5.5",
		"leading-13",
	]);
});

it("finds fixed lengths in inline styles, leaving computed ones", () => {
	const source = `<div style={{ width: 12, maxWidth: "520px", padding: "1.5rem", left: \`\${offset}%\`, opacity: 0.5, height: size }} />`;
	expect(tailwindValueViolations("style.tsx", source).map(({ token }) => token)).toEqual([
		"style width: 12",
		"style maxWidth: 520px",
		"style padding: 1.5rem",
	]);
});
