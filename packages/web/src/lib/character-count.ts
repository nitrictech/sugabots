const COUNT = new Intl.NumberFormat("en");

/** How much of a text's room is used, for a note under its box: "1,204 of 20,000 characters". */
export function characterCount(length: number, maxLength: number): string {
	return `${COUNT.format(length)} of ${COUNT.format(maxLength)} characters`;
}
