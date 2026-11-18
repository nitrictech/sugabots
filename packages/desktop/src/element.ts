/** The page's element matching `selector`, which the page's HTML must have. */
export function element<T extends Element>(selector: string, type: new () => T): T {
	const found = document.querySelector(selector);
	if (!(found instanceof type)) throw new Error(`The page has no ${selector}`);
	return found;
}
