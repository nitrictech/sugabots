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
