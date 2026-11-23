type Row = Record<string, unknown>;

/**
 * A stand-in for supabase that answers like PostgREST with its default max_rows: whatever the
 * query asks for, at most `cap` rows per request. Filters are ignored (give it the rows a query
 * would match); order() and range() are honoured.
 */
export function cappedClient(tables: Record<string, Array<Row>>, cap = 1000) {
  const requests: Array<string> = [];
  const from = (table: string) => {
    const sorts: Array<[string, boolean]> = [];
    let skip = 0;
    let max = Infinity;
    const q = {
      select: () => q,
      eq: () => q,
      gte: () => q,
      is: () => q,
      not: () => q,
      order: (col: string, opts?: { ascending?: boolean }) => {
        sorts.push([col, opts?.ascending ?? true]);
        return q;
      },
      range: (a: number, b: number) => {
        skip = a;
        max = b + 1;
        return q;
      },
      then: <T>(done: (r: { data: Array<Row>; error: null }) => T) => {
        requests.push(table);
        const sorted = [...(tables[table] ?? [])].sort((x, y) => {
          for (const [col, asc] of sorts) {
            const a = x[col] as string | number;
            const b = y[col] as string | number;
            if (a !== b) return (a < b ? -1 : 1) * (asc ? 1 : -1);
          }
          return 0;
        });
        const end = Math.min(max, skip + cap);
        return Promise.resolve(done({ data: sorted.slice(skip, end), error: null }));
      },
    };
    return q;
  };
  return { client: { from }, requests };
}
