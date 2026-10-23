import { cva } from "class-variance-authority";

/** The landing page's link buttons: Self-host is `primary`, Join the waitlist `secondary` or, in the header, `quiet`. */
export const callToAction = cva(
	"inline-flex items-center justify-center whitespace-nowrap transition-colors duration-150 outline-none focus-visible:ring-3 focus-visible:ring-white/40",
	{
		variants: {
			variant: {
				primary:
					"bg-landing-text font-semibold text-landing-page hover:bg-white hover:text-landing-page",
				secondary:
					"border border-landing-control font-medium text-landing-button-text hover:border-landing-control-hover hover:text-white",
				quiet: "font-medium text-landing-button-text hover:bg-landing-bubble hover:text-white",
			},
			size: {
				large: "rounded-[10px] px-[22px] py-[13px] text-[15px] leading-none",
				small: "rounded-[9px] px-3.5 py-[9px] text-sm leading-none",
			},
		},
		compoundVariants: [{ variant: "primary", size: "small", className: "px-4" }],
		defaultVariants: { variant: "primary", size: "large" },
	},
);
