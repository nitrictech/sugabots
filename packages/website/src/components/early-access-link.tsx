import type { VariantProps } from "class-variance-authority";
import { MailIcon } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { siteLinks } from "@/site-links";

/** A link to a pre-filled email asking to hear when Sugabots is ready. For use before launch. */
export function EarlyAccessLink({ size, variant }: VariantProps<typeof buttonVariants>) {
	return (
		<a href={siteLinks.earlyAccess} className={buttonVariants({ size, variant })}>
			Let me know when it's ready
			<MailIcon data-icon="inline-end" />
		</a>
	);
}
