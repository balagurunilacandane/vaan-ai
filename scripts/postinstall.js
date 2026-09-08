// Fail loudly at install, not three turns into a REPL.
//
// vaan's memory is SQLite with FTS5, and there is no fallback path.
// Official Node builds ship node:sqlite compiled *without* FTS5, so we
// depend on better-sqlite3, which bundles its own SQLite. If that native
// module was built without FTS5 — a bad prebuild, an exotic platform — every
// recall would throw "no such module: fts5" at query time. This probe is the
// only thing standing between that and a broken release.

const FIX = `
  vaan needs SQLite with FTS5, and this build doesn't have it.

  Rebuild better-sqlite3 from source:

      npm install better-sqlite3 --build-from-source

  That needs a C++ toolchain:

      macOS    xcode-select --install
      Debian   sudo apt-get install -y build-essential python3
      Alpine   apk add --no-cache build-base python3
      Windows  npm install --global windows-build-tools

  Still stuck? Please open an issue and include the error above:
  https://github.com/balagurunilacandane/looplet/issues/new?template=install-failed.md
`;

let Database;
try {
  ({ default: Database } = await import("better-sqlite3"));
} catch (err) {
  console.error("\n  vaan: could not load better-sqlite3.\n");
  console.error(`  ${err.message}\n`);
  console.error(FIX);
  process.exit(1);
}

try {
  const db = new Database(":memory:");
  db.exec("CREATE VIRTUAL TABLE probe USING fts5(x)");
  db.close();
} catch (err) {
  console.error("\n  vaan: SQLite is missing the FTS5 extension.\n");
  console.error(`  ${err.message}\n`);
  console.error(FIX);
  process.exit(1);
}
