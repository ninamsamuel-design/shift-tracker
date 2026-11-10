// Tests for the stale-data safeguard in storageAdapter (index.html), run
// against an in-memory stand-in for Supabase's kv_store table.
// Usage: node tests/storage.test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// ---- minimal fake of the supabase-js query builder (just what the app uses)
function makeFakeSupabase() {
  const rows = new Map(); // "user|key" -> { user_id, key, value, updated_at }
  let tick = 0;
  const serverStamp = () => new Date(Date.UTC(2026, 0, 1) + (++tick) * 1000 + 123).toISOString().replace("Z", "+00:00"); // server-style format
  class Q {
    constructor() { this.mode = "select"; this.filters = []; this.returning = false; this.cols = null; }
    select(cols) { if (this.mode === "select") this.cols = cols; else this.returning = true; return this; }
    eq(c, v) { this.filters.push([c, v]); return this; }
    in(c, vs) { this.filters.push([c, vs]); return this; }
    upsert(row) { this.mode = "upsert"; this.row = row; return this; }
    insert(row) { this.mode = "insert"; this.row = row; return this; }
    update(patch) { this.mode = "update"; this.patch = patch; return this; }
    match(r) { return this.filters.every(([c, v]) => Array.isArray(v) ? v.includes(r[c]) : r[c] === v); }
    run() {
      const all = [...rows.values()];
      if (this.mode === "select") return { data: all.filter(r => this.match(r)).map(r => ({ ...r })), error: null };
      if (this.mode === "insert") {
        const k = this.row.user_id + "|" + this.row.key;
        if (rows.has(k)) return { data: null, error: { code: "23505" } };
        const r = { ...this.row, updated_at: serverStamp() }; rows.set(k, r);
        return { data: [{ updated_at: r.updated_at }], error: null };
      }
      if (this.mode === "upsert") {
        const k = this.row.user_id + "|" + this.row.key;
        const r = { ...this.row, updated_at: serverStamp() }; rows.set(k, r);
        return { data: [{ updated_at: r.updated_at }], error: null };
      }
      const hit = all.filter(r => this.match(r));
      hit.forEach(r => { r.value = this.patch.value; r.updated_at = serverStamp(); });
      return { data: hit.map(r => ({ updated_at: r.updated_at })), error: null };
    }
    maybeSingle() { const r = this.run(); return Promise.resolve({ data: r.data[0] || null, error: r.error }); }
    then(res, rej) { return Promise.resolve(this.run()).then(res, rej); }
  }
  return { rows, client: { from: () => new Q() }, otherDeviceWrites(key, value) { const r = rows.get("u1|" + key); const nr = { user_id: "u1", key, value, updated_at: serverStamp() }; rows.set("u1|" + key, nr); return nr; } };
}

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const script = html.match(/<script>\n(const SUPABASE_URL[\s\S]*?)<\/script>/)[1].replace(/\ninit\(\);\s*$/, "\n");

let failures = 0, checks = 0;
const t = (label, ok) => { checks++; if (!ok) failures++; console.log((ok ? "  ok   " : "  FAIL ") + label); };

async function fresh() {
  const fake = makeFakeSupabase();
  const dummy = new Proxy(function () {}, { get: (_, k) => (k === "style" ? {} : k === "value" ? "" : dummy), apply: () => dummy, set: () => true });
  const doc = { getElementById: () => dummy, createElement: () => dummy, addEventListener() {}, visibilityState: "visible" };
  const ctx = vm.createContext({ window: { supabase: { createClient: () => fake.client }, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) }, document: doc, console: { log() {}, error() {}, warn() {} }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } });
  vm.runInContext(script, ctx);
  vm.runInContext('storageAdapter.session = { user: { id: "u1" } };', ctx);
  return { fake, run: c => vm.runInContext(c, ctx) };
}

(async () => {
  // 1. normal load -> save -> save works and advances the version
  let { fake, run } = await fresh();
  fake.otherDeviceWrites("entries", "[1]");
  await run('storageAdapter.get("entries")');
  await run('storageAdapter.set("entries", "[1,2]")');
  t("a normal save after loading goes through", fake.rows.get("u1|entries").value === "[1,2]" && run("storageAdapter.conflict") === null);
  await run('storageAdapter.set("entries", "[1,2,3]")');
  t("consecutive saves keep working (version tracks our own writes)", fake.rows.get("u1|entries").value === "[1,2,3]" && run("storageAdapter.conflict") === null);

  // 2. another device saved after we loaded -> our save is refused, theirs is untouched
  ({ fake, run } = await fresh());
  fake.otherDeviceWrites("entries", "[1]");
  await run('storageAdapter.get("entries")');
  fake.otherDeviceWrites("entries", "[1,\"newer\"]");
  await run('storageAdapter.set("entries", "[1,\\"stale-overwrite\\"]")');
  t("a stale save is refused", run("storageAdapter.conflict && storageAdapter.conflict.key") === "entries");
  t("...and the newer data on the server is NOT overwritten", fake.rows.get("u1|entries").value === '[1,"newer"]');

  // 3. "save mine anyway" overwrites on purpose
  await run("resolveConflictOverwrite()");
  t("'save this page's version anyway' overwrites deliberately", fake.rows.get("u1|entries").value === '[1,"stale-overwrite"]' && run("storageAdapter.conflict") === null);

  // 4. "load the latest" discards the refused change and adopts the server's data
  ({ fake, run } = await fresh());
  fake.otherDeviceWrites("entries", "[]");
  await run('storageAdapter.get("entries")');
  fake.otherDeviceWrites("entries", '[{"id":"x","date":"2026-01-01","type":"shift","hours":12}]');
  await run('storageAdapter.set("entries", "[]")');
  await run("resolveConflictLoadLatest()");
  t("'load the latest' pulls in the newer entries and clears the warning", run("entries.length") === 1 && run("storageAdapter.conflict") === null);
  await run('storageAdapter.set("entries", JSON.stringify(entries))');
  t("saving works again right after loading the latest", run("storageAdapter.conflict") === null);

  // 5. coming back to the foreground pulls newer data in before it can be overwritten
  ({ fake, run } = await fresh());
  fake.otherDeviceWrites("entries", "[]");
  fake.otherDeviceWrites("settings", '{"baseRate":79.23}');
  await run('loadDataFromStorage()');
  fake.otherDeviceWrites("entries", '[{"id":"y","date":"2026-02-02","type":"shift","hours":8}]');
  const refreshed = await run("storageAdapter.refreshIfStale()");
  t("returning to the app reloads data another device changed", refreshed === true && run("entries.length") === 1);
  t("...and does nothing when nothing changed", (await run("storageAdapter.refreshIfStale()")) === false);

  // 6. first-ever save (no row yet) works; a racing first save is a conflict
  ({ fake, run } = await fresh());
  await run('storageAdapter.get("entries")');
  await run('storageAdapter.set("entries", "[7]")');
  t("first save when no row exists works", fake.rows.get("u1|entries").value === "[7]");
  ({ fake, run } = await fresh());
  await run('storageAdapter.get("entries")'); // sees no row
  fake.otherDeviceWrites("entries", "[8]");   // another device creates it first
  await run('storageAdapter.set("entries", "[9]")');
  t("a racing first save is refused instead of overwriting", fake.rows.get("u1|entries").value === "[8]" && run("storageAdapter.conflict !== null"));

  // 7. collapsed-weeks list is last-write-wins and never raises a warning
  ({ fake, run } = await fresh());
  fake.otherDeviceWrites("savedWeeks", "[]");
  await run('storageAdapter.get("savedWeeks")');
  fake.otherDeviceWrites("savedWeeks", '["2026-01-04"]');
  await run('storageAdapter.set("savedWeeks", "[]")');
  t("savedWeeks (UI-only) doesn't trigger the warning", run("storageAdapter.conflict") === null);

  console.log("\n" + (failures ? failures + " of " + checks + " checks FAILED" : "all " + checks + " checks passed"));
  process.exit(failures ? 1 : 0);
})();
