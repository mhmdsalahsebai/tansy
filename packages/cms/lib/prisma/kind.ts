export type DatabaseKind = "sqlite" | "postgres";

/** The connection string decides, so one build runs against either database. */
export const databaseKind = (url = process.env.DATABASE_URL ?? ""): DatabaseKind => (/^postgres(ql)?:\/\//i.test(url) ? "postgres" : "sqlite");

export const isPostgres = () => databaseKind() === "postgres";
