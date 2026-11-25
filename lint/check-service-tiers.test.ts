import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { tierViolations, type Violation } from "./check-service-tiers.ts";

const ROOT = resolve(import.meta.dirname, "..");
const FIXTURES = join(import.meta.dirname, "fixtures", "service-tiers");

/**
 * The service tier check over the fixtures in `fixtures/service-tiers/`, each
 * a small module breaking one rule, or `accepted.ts`, which breaks none.
 */
describe("the service tier check", () => {
	let violations: Violation[];

	beforeAll(() => {
		violations = tierViolations({
			root: ROOT,
			tsconfigs: [join(FIXTURES, "tsconfig.json")],
			isChecked: (file) => file.startsWith(FIXTURES),
		});
	});

	/** What the check reports in one fixture, as `line: message`. */
	const reportedIn = (fixture: string) =>
		violations
			.filter(({ file }) => file === join("lint", "fixtures", "service-tiers", fixture))
			.map(({ line, message }) => `${line}: ${message}`);

	it("accepts services that declare a tier and layers that go through their wrapper", () => {
		expect(reportedIn("accepted.ts")).toEqual([]);
	});

	it("finds a service without a tier", () => {
		expect(reportedIn("unmarked-service.ts")).toEqual([
			expect.stringContaining("Registry extends Context.Service without a tier"),
		]);
	});

	it("finds a service whose tier is the workspace's, which is empty", () => {
		expect(reportedIn("workspace-tier-service.ts")).toEqual([
			expect.stringContaining("PerWorkspace declares the workspace tier, which is empty"),
		]);
	});

	it("finds a service declared as a call, which has nowhere to declare a tier", () => {
		expect(reportedIn("service-as-call.ts")).toEqual([
			expect.stringContaining("Context.Service is declared as a class"),
		]);
	});

	it("finds a layer that does not go through the wrapper, however it builds", () => {
		expect(reportedIn("unwrapped-layers.ts")).toEqual([
			expect.stringContaining("Layer.effect builds Registry"),
			expect.stringContaining("Layer.succeed builds Registry"),
			expect.stringContaining("Layer.succeedContext is built once, at boot"),
			expect.stringContaining("Layer.effectDiscard is built once, at boot"),
			expect.stringContaining("Layer.unwrap is built once, at boot"),
			expect.stringContaining("Layer.fromBuild is built once, at boot"),
		]);
	});

	it("finds a request-tier service built once by a layer", () => {
		expect(reportedIn("request-tier-layer.ts")).toEqual([
			expect.stringContaining("CurrentRequest is request tier: it is provided for one call"),
		]);
	});

	it("finds a curried layer that is not wrapped, and one left half applied", () => {
		expect(reportedIn("curried-layers.ts")).toEqual([
			expect.stringContaining("Layer.effect builds Registry"),
			expect.stringContaining("Layer.effect(Service) is the first half of a layer"),
		]);
	});

	it("reads what names are bound to, not how they are spelled", () => {
		expect(reportedIn("spellings.ts")).toEqual([
			expect.stringContaining("NotMarked extends Context.Service without a tier"),
			expect.stringContaining("Registry extends Context.Service without a tier"),
			expect.stringContaining("Layer.effect builds key"),
		]);
	});
});
