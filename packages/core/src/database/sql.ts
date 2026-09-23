import { sql } from "drizzle-orm";
import { timestamp, uuid } from "drizzle-orm/pg-core";

export const primaryKey = () => uuid("id").primaryKey().default(sql`uuidv7()`);

export const stamp = (name: string) =>
	timestamp(name, { withTimezone: true }).notNull().defaultNow();

export const updatedStamp = (name: string) => stamp(name).$onUpdate(() => new Date());
