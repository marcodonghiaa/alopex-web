/**
 * A PostgREST `in` list, for `.filter(column, "in", inList(values))`. postgrest-js's own in()
 * quotes a value only when it has a comma or bracket and never escapes a quote, so a name the
 * user typed ('Kids "school"', 'Food, "extras"') breaks the list. Every value is quoted here,
 * with its quotes and backslashes escaped.
 */
export const inList = (values: ReadonlyArray<string>): string =>
  `(${values.map((v) => `"${v.replace(/[\\"]/g, "\\$&")}"`).join(",")})`;
