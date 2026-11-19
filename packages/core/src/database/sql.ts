import { Column, getColumnTable, is, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { timestamp, uuid } from "drizzle-orm/pg-core";

export const primaryKey = () => uuid("id").primaryKey().default(sql`uuidv7()`);

export const stamp = (name: string) =>
	timestamp(name, { withTimezone: true }).notNull().defaultNow();

export const updatedStamp = (name: string) => stamp(name).$onUpdate(() => sql`now()`);

/**
 * `value` for use inside a raw `sql` subquery that reads it from the outer
 * query: a column with its table's name, or its alias's, written in front;
 * anything else, a bound value or an SQL expression, unchanged. Drizzle leaves
 * the table off the columns of a query over one table, and a subquery would
 * read such a bare name as a column of its own tables.
 */
export function outerColumn<Value extends SQLWrapper | string>(value: Value): Value | SQL {
	if (!is(value, Column)) return value;
	return sql`${getColumnTable(value)}.${sql.identifier(value.name)}`;
}
