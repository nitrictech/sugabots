import { useRender } from "@base-ui/react/use-render";
import { cn } from "cn";
import type { ReactNode } from "react";

export function SettingsResourceCard({
	children,
	render,
	className,
}: {
	children: ReactNode;
	render?: useRender.RenderProp;
	className?: string;
}) {
	return useRender({
		render,
		defaultTagName: "div",
		props: {
			className: cn(
				"flex min-h-20 items-center gap-3 rounded-xl border border-border-subtle px-4 py-3",
				className,
			),
			children,
		},
	});
}
