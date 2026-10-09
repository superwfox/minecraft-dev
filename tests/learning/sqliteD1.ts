import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Real SQLite transactions using the same Python stdlib as the build producer.
const RUNNER = `import json, sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.row_factory = sqlite3.Row
request = json.load(sys.stdin)
try:
 if 'script' in request:
  db.executescript(request['script'])
  result = []
 else:
  db.execute('BEGIN')
  result = []
  for item in request['statements']:
   cursor = db.execute(item['sql'], item['args'])
   rows = [dict(row) for row in cursor.fetchall()] if cursor.description else []
   result.append({'success': True, 'results': rows, 'meta': {'changes': max(0, cursor.rowcount)}})
  db.commit()
 print(json.dumps(result))
except Exception as error:
 db.rollback()
 print(json.dumps({'error': str(error)}))
 sys.exit(1)
finally:
 db.close()
`;

export function sqliteD1() {
    const directory = mkdtempSync(join(tmpdir(), "negative-api-sqlite-"));
    const file = join(directory, "test.db");
    function execute(request: unknown): any[] {
        const result = spawnSync("python3", ["-c", RUNNER, file], { input: JSON.stringify(request), encoding: "utf8" });
        if (result.status !== 0) throw new Error(result.stdout || result.stderr || "SQLite unavailable");
        return JSON.parse(result.stdout);
    }
    execute({ script: ["CREATE TABLE generation_tasks (task_id TEXT PRIMARY KEY, owner_uid TEXT, planner_lease_token TEXT);",
        readFileSync(new URL("../../migrations/0002_autonomous_learning.sql", import.meta.url), "utf8"),
        readFileSync(new URL("../../migrations/0005_negative_api_facts.sql", import.meta.url), "utf8")].join("\n") });
    const db = {
        prepare(sql: string) {
            const statement: any = { sql, args: [],
                bind(...args: unknown[]) { this.args = args; return this; },
                async all() { return execute({ statements: [{ sql, args: this.args }] })[0]; },
                async first(column?: string) { const row = (await this.all()).results[0] ?? null; return column && row ? row[column] : row; },
                async run() { return this.all(); },
            };
            return statement;
        },
        async batch(statements: any[]) {
            return execute({ statements: statements.map(({ sql, args }) => ({ sql, args })) });
        },
    } as unknown as D1Database;
    return { db, close: () => rmSync(directory, { recursive: true, force: true }) };
}
