import { type ComponentType, lazy, useState } from "react";

/**
 * A screen's named export as a component that loads its module on first render,
 * with `preload` to start the load sooner. Both share one load; a failed preload
 * is forgotten, so opening the screen fetches again.
 *
 * Once the module is here, the screen renders without suspending: `lazy` alone
 * would suspend once even then, and hold the screen behind React's 300ms reveal throttle.
 *
 * `load` resolves to a module holding only `name`: a screen that is one of
 * several exports is picked out with `.then(({ Screen }) => ({ Screen }))`, or
 * the module's other exports would decide `Props`.
 *
 * TanStack Router's `lazyRouteComponent` is not used because it calls `use()`
 * only while the module is still loading, and React 19.3 reports a render that
 * suspends on `use()` and then finishes without calling it as an error.
 */
export function lazyNamed<Name extends string, Props extends object>(
	load: () => Promise<Record<Name, ComponentType<Props>>>,
	name: Name,
) {
	let loading: Promise<{ default: ComponentType<Props> }> | undefined;
	let loaded: ComponentType<Props> | undefined;
	const loadScreenModule = () => {
		loading ??= load().then(
			(module) => {
				loaded = module[name];
				return { default: loaded };
			},
			(error: unknown) => {
				loading = undefined;
				throw error;
			},
		);
		return loading;
	};
	const Lazy = lazy(loadScreenModule);
	function Screen(props: Props) {
		// Chosen once per mount: swapping `Lazy` for the loaded component would remount the screen.
		const [Component] = useState<ComponentType<Props>>(() => loaded ?? Lazy);
		return <Component {...props} />;
	}
	Screen.displayName = name;
	const preload = () => {
		loadScreenModule().catch(() => {});
	};
	return Object.assign(Screen, { preload });
}
