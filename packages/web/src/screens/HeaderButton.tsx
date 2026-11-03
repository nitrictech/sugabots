import type { useRender } from "@base-ui/react/use-render";
import { cn } from "cn";
import type { ReactNode } from "react";
import { FLOATING_ON_PHONE, IconButton } from "@/ui/icon-button.tsx";

/**
 * The container a chat's header is, which a `HeaderButton` measures to know
 * whether its name fits beside its icon.
 */
export const CHAT_HEADER_CONTAINER = "@container/chat-header";

/**
 * A button in a chat's header: its icon, with its name beside it while the
 * header is wide enough, and only the icon, with the name as its tooltip,
 * while it is not. On a phone, only the icon, round on glass.
 */
export function HeaderButton({
	label,
	icon,
	render,
	onClick,
	className,
}: {
	label: string;
	icon: ReactNode;
	render?: useRender.RenderProp;
	onClick?: () => void;
	className?: string;
}) {
	return (
		<IconButton
			label={label}
			variant="bar"
			render={render}
			onClick={onClick}
			className={cn(
				"text-muted-foreground hover:text-foreground md:@2xl/chat-header:flex md:@2xl/chat-header:w-auto md:@2xl/chat-header:gap-1.5 md:@2xl/chat-header:px-2.5",
				FLOATING_ON_PHONE,
				className,
			)}
		>
			{icon}
			<span className="hidden font-medium text-xs md:@2xl/chat-header:inline">{label}</span>
		</IconButton>
	);
}
