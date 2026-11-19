/** Runs one statement and prints its result, so the test suite can stay synchronous on Postgres. */
import pg from "pg";

const [url, text, params] = process.argv.slice(2);
const parsers = { 20: Number, 114: (value) => value, 3802: (value) => value };
const getTypeParser = (oid, format) => parsers[oid] ?? pg.types.getTypeParser(oid, format);
const client = new pg.Client({ connectionString: url, types: { getTypeParser } });
await client.connect();
let index = 0;
const result = await client.query(text.replace(/\?/g, () => `$${++index}`), JSON.parse(params));
await client.end();
process.stdout.write(JSON.stringify({ rows: result.rows, rowCount: result.rowCount }));
