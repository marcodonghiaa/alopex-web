// PostgREST's answers when the backend lacks a function or table: a migration was not applied.
type PgError = { code?: string | undefined; message?: string | undefined };

export const isMissingFunction = (error: PgError) =>
  error.code === "PGRST202" || error.message?.startsWith("Could not find the function") === true;

export const isMissingTable = (error: PgError) =>
  error.code === "PGRST205" || error.code === "42P01";
