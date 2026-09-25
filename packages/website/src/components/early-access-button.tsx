import { MailIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { siteLinks } from "@/site-links";

type EarlyAccessButtonProps = Pick<ComponentProps<typeof Button>, "size" | "variant">;

/** Opens a pre-filled email asking to hear when Sugabots is ready. For use before launch. */
export function EarlyAccessButton(props: EarlyAccessButtonProps) {
	return (
		<Button nativeButton={false} render={<a href={siteLinks.earlyAccess} />} {...props}>
			Let me know when it's ready
			<MailIcon data-icon="inline-end" />
		</Button>
	);
}
