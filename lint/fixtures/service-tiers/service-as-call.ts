import { Context } from "effect";

export const Registry = Context.Service<{ readonly size: number }>("fixtures/Registry");
