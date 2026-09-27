import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import type { MDXComponents } from "mdx/types";
import type { ComponentProps } from "react";
import { CodeBlock } from "@/docs/components/code-block";

const DOCS_LINK = /^\/docs\/([^/#]+)\/?(#.*)?$/;

/** Links to other docs pages go through the router; everything else is a plain link, external ones in a new tab. */
function ProseLink({ href = "", className, children, ...props }: ComponentProps<"a">) {
	const classes = cn(
		"font-semibold text-foreground underline decoration-brand/40 decoration-2 underline-offset-4 transition-colors hover:decoration-brand",
		className,
	);
	const docsLink = DOCS_LINK.exec(href);
	if (docsLink?.[1]) {
		return (
			<Link
				to="/docs/$slug"
				params={{ slug: docsLink[1] }}
				hash={docsLink[2]?.slice(1)}
				className={classes}
			>
				{children}
			</Link>
		);
	}
	const external = /^https?:\/\//.test(href);
	return (
		<a
			href={href}
			className={classes}
			{...(external ? { target: "_blank", rel: "noreferrer" } : {})}
			{...props}
		>
			{children}
		</a>
	);
}

function Heading2({ id, children, className, ...props }: ComponentProps<"h2">) {
	return (
		<h2
			id={id}
			className={cn(
				"group/heading mt-16 mb-4 scroll-mt-24 text-3xl font-extrabold tracking-tight text-balance",
				className,
			)}
			{...props}
		>
			<a href={`#${id}`} className="relative">
				<span
					aria-hidden
					className="absolute top-0 -left-6 text-muted-foreground/60 opacity-0 transition-opacity group-hover/heading:opacity-100 max-sm:hidden"
				>
					#
				</span>
				{children}
			</a>
		</h2>
	);
}

/** How Markdown elements look on a docs page. */
export const proseComponents: MDXComponents = {
	h2: Heading2,
	h3: ({ className, ...props }) => (
		<h3 className={cn("mt-10 mb-3 scroll-mt-24 text-xl font-bold", className)} {...props} />
	),
	p: ({ className, ...props }) => (
		<p className={cn("my-4 leading-7 text-pretty text-foreground/85", className)} {...props} />
	),
	a: ProseLink,
	strong: ({ className, ...props }) => (
		<strong className={cn("font-semibold text-foreground", className)} {...props} />
	),
	ul: ({ className, ...props }) => (
		<ul
			className={cn(
				"my-4 flex list-disc flex-col gap-2 pl-6 text-foreground/85 marker:text-muted-foreground/60",
				className,
			)}
			{...props}
		/>
	),
	ol: ({ className, ...props }) => (
		<ol
			className={cn(
				"my-4 flex list-decimal flex-col gap-2 pl-6 text-foreground/85 marker:font-semibold marker:text-muted-foreground",
				className,
			)}
			{...props}
		/>
	),
	li: ({ className, ...props }) => <li className={cn("pl-1 leading-7", className)} {...props} />,
	// Inline code's chip is in styles.css, since a code block's <code> comes through here too.
	code: ({ className, ...props }) => <code className={cn("font-mono", className)} {...props} />,
	pre: CodeBlock,
	hr: () => <hr className="my-12" />,
	blockquote: ({ className, ...props }) => (
		<blockquote
			className={cn("my-6 border-l-4 border-brand/40 pl-5 text-muted-foreground", className)}
			{...props}
		/>
	),
	table: ({ className, ...props }) => (
		<div className="my-6 overflow-x-auto rounded-2xl ring-1 ring-foreground/10">
			<table className={cn("w-full text-left text-sm", className)} {...props} />
		</div>
	),
	thead: ({ className, ...props }) => <thead className={cn("bg-card", className)} {...props} />,
	tr: ({ className, ...props }) => (
		<tr className={cn("border-b last:border-b-0", className)} {...props} />
	),
	th: ({ className, ...props }) => (
		<th className={cn("px-4 py-3 font-semibold whitespace-nowrap", className)} {...props} />
	),
	td: ({ className, ...props }) => (
		<td className={cn("px-4 py-3 align-top text-foreground/85", className)} {...props} />
	),
};
