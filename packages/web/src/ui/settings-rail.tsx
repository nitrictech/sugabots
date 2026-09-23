import { useRender } from "@base-ui/react/use-render";
import { cn } from "cn";
import type { ComponentProps, ReactNode } from "react";

export function SettingsSplitView({
	showDetail,
	rail,
	detail,
	className,
	detailScrollable = true,
}: {
	showDetail: boolean;
	rail: ReactNode;
	detail: ReactNode;
	className?: string;
	detailScrollable?: boolean;
}) {
	return (
		<div
			className={cn(
				"min-h-0 flex-1 overflow-hidden lg:grid lg:grid-cols-[266px_minmax(0,1fr)]",
				className,
			)}
		>
			<div className={showDetail ? "hidden h-full min-h-0 lg:block" : "h-full min-h-0"}>{rail}</div>
			<div
				className={`${showDetail ? "flex" : "hidden lg:flex"} h-full min-h-0 flex-col ${detailScrollable ? "overflow-y-auto" : "overflow-y-hidden"}`}
			>
				{detail}
			</div>
		</div>
	);
}

export function SettingsRail({
	label,
	children,
	footer,
}: {
	label: string;
	children: ReactNode;
	footer?: ReactNode;
}) {
	return (
		<aside className="flex h-full min-h-0 flex-col border-r border-border-subtle bg-card">
			<nav aria-label={label} className="min-h-0 flex-1 space-y-1 overflow-y-auto px-4 py-5">
				{children}
			</nav>
			{footer && <div className="border-t border-border p-4">{footer}</div>}
		</aside>
	);
}

export interface SettingsRailItemProps extends Omit<ComponentProps<"button">, "children"> {
	selected: boolean;
	children: ReactNode;
	render?: useRender.RenderProp;
}

export function SettingsRailItem({
	selected,
	children,
	render,
	className,
	...props
}: SettingsRailItemProps) {
	return useRender({
		render,
		defaultTagName: "button",
		props: {
			type: render ? undefined : "button",
			"aria-current": selected ? "page" : undefined,
			className: cn(
				"focus-ring flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors",
				selected
					? "bg-primary-tint/50 shadow-[inset_0_0_0_1px_var(--color-primary-tint-border)] hover:bg-primary-tint/50"
					: "hover:bg-accent",
				className,
			),
			children,
			...props,
		},
	});
}
