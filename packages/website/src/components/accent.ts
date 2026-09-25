import { cva, type VariantProps } from "class-variance-authority";

/** Accent text colours, lighter in dark mode to keep their contrast. */
export const accentText = cva("", {
	variants: {
		tone: {
			emerald: "text-emerald-600 dark:text-emerald-400",
			sky: "text-sky-600 dark:text-sky-400",
			orange: "text-orange-600 dark:text-orange-400",
			pink: "text-pink-600 dark:text-pink-400",
			purple: "text-purple-600 dark:text-purple-400",
		},
	},
});

export type AccentTone = NonNullable<VariantProps<typeof accentText>["tone"]>;
