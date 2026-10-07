// Acceptance tests for the pay engine in index.html, run against real
// paystub periods. Usage:  node tests/payroll.test.js [baseRate]
//
// The entries come from tests/fixtures.local.json, which is gitignored on
// purpose (this repo is public and the fixture is real shift data). Without
// that file the tests are skipped.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const fixturePath = path.join(__dirname, "fixtures.local.json");
if (!fs.existsSync(fixturePath)) { console.log("SKIP: tests/fixtures.local.json not found"); process.exit(0); }
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const script = html.match(/<script>\n(const SUPABASE_URL[\s\S]*?)<\/script>/)[1].replace(/\ninit\(\);\s*$/, "\n");
const ctx = vm.createContext({ window: {}, console });
vm.runInContext(script, ctx);
const run = (code) => vm.runInContext(code, ctx);

run("settings = { ...DEFAULT_SETTINGS, ..." + JSON.stringify(fixture.settings) + " }");
if (process.argv[2]) run("settings.baseRate = " + parseFloat(process.argv[2]));
run("entries = " + JSON.stringify(fixture.entries));

let failures = 0, checks = 0;
// Hours must match exactly. Dollars are allowed $0.02: the paystub rounds per
// pay code at a rate with more decimals than the $79.23 in settings (79.2303
// reproduces both gross totals exactly), so a cent or two of drift is
// expected at $79.23.
const MONEY_TOL = 0.02;
function check(label, actual, expected, tol) {
  checks++;
  const ok = Math.abs(actual - expected) <= (tol === undefined ? 0.005 : tol);
  if (!ok) failures++;
  console.log((ok ? "  ok   " : "  FAIL ") + label.padEnd(34) + "actual " + actual.toFixed(2).padStart(9) + "   expected " + expected.toFixed(2).padStart(9));
}
function summary(start, end) { return JSON.parse(run(`JSON.stringify(computeExpectedSummary("${start}", "${end}"))`)); }

console.log("baseRate " + run("settings.baseRate") + "\n");

console.log("08/30-09/12 (payroll mode)");
{
  const s = summary("2026-08-30", "2026-09-12"), p = s.period;
  check("Regular (incl. education)", p.regular, 67.50);
  check("  week 1 Regular", s.weeks[0].cats.regular, 35.50);
  check("  week 2 Regular", s.weeks[1].cats.regular, 32.00);
  check("OT-Straight", p.otStraight, 13.50);
  check("OT-Double", p.otDouble, 8.75);
  check("Holiday", p.holiday, 8.00);
  check("Time On Call", p.onCallStandby, 59.50);
  check("Time On Call - 50%", p.t50, 0);
  check("Weekend diff", p.weekendDiff, 6.25);
  check("Certification $", p.certPay, 41.54);
  check("Week 1 pay", s.weeks[0].cats.payRounded, 4257.18, MONEY_TOL);
  check("Week 2 pay", s.weeks[1].cats.payRounded, 4742.87, MONEY_TOL);
  check("GROSS", p.payRounded, 9000.05, MONEY_TOL);
  check("Contract flags: hours", s.flags.reduce((t, f) => t + f.hours, 0), 1.25);
  check("Contract flags: dollars", s.flags.reduce((t, f) => t + f.delta, 0), 49.52);
}

console.log("\n09/13-09/26 (payroll mode)");
{
  const s = summary("2026-09-13", "2026-09-26"), p = s.period;
  check("Regular (incl. education)", p.regular, 67.25);
  check("  week 1 Regular", s.weeks[0].cats.regular, 31.50);
  check("  week 2 Regular", s.weeks[1].cats.regular, 35.75);
  check("OT-Straight", p.otStraight, 4.50);
  check("OT-Double", p.otDouble, 4.50);
  check("Comp time used", p.compUsed, 4.00);
  check("Time On Call", p.onCallStandby, 31.00);
  check("  week 1 Time On Call", s.weeks[0].cats.onCallStandby, 19.50);
  check("  week 2 Time On Call", s.weeks[1].cats.onCallStandby, 11.50);
  check("Time On Call - 50%", p.t50, 12.00);
  check("Weekend diff", p.weekendDiff, 3.25);
  check("Certification $", p.certPay, 0);
  check("Week 1 pay", s.weeks[0].cats.payRounded, 4403.48, MONEY_TOL);
  check("Week 2 pay", s.weeks[1].cats.payRounded, 3062.48, MONEY_TOL);
  check("GROSS", p.payRounded, 7465.96, MONEY_TOL);
  check("Contract flags (count)", s.flags.length, 0);
}

console.log("\nrule tests (synthetic entries)");
{
  const base = run("JSON.stringify(settings)");
  const E = (id, date, type, hours, startTime, endTime, extra) => Object.assign({ id, date, type, hours, startTime, endTime, diffMode: "none", restViolation: false, mealSkipped: false }, extra || {});
  const weeks = (list) => { run("entries = " + JSON.stringify(list)); return JSON.parse(run("JSON.stringify(computeWeeks())")); };
  const lines = (list) => weeks(list).flatMap(w => w.entries).flatMap(e => e.result.lines.map(l => ({ id: e.id, ...l })));
  const has = (ls, id, text) => ls.some(l => l.id === id && l.label.includes(text));
  const t = (label, ok) => { checks++; if (!ok) failures++; console.log((ok ? "  ok   " : "  FAIL ") + label); };

  let ls = lines([E("a", "2026-10-06", "shift", 11.75, "07:09", "19:24"), E("b", "2026-10-07", "shift", 11.75, "07:08", "19:23")]);
  t("consecutive scheduled shifts stay separate workdays (no daily OT)", !ls.some(l => l.label.includes(">12h workday")));

  ls = lines([E("c", "2026-10-11", "callback", 3.25, "09:49", "12:53"), E("s", "2026-10-12", "shift", 13.25, "05:38", "19:23")]);
  t("call-in + next-day shift inside 24h = one workday, 4.5h daily OT", has(ls, "s", "4.5h OT-Double (>12h workday)"));
  t("workday that began with a call-in gets T50 on its 12 non-OT hours", has(ls, "c", "3.25h Time On Call – 50%") && has(ls, "s", "8.75h Time On Call – 50%"));

  ls = lines([E("d", "2026-10-06", "shift", 11, "07:00", "18:30"), E("e", "2026-10-06", "callback", 3, "20:00", "23:00")]);
  t("workday that began with a scheduled shift gets NO T50", !ls.some(l => l.label.includes("T50")));

  ls = lines([E("f", "2026-10-13", "callback", 2.25, "03:30", "05:52"), E("g", "2026-10-13", "shift", 8.75, "10:22", "19:23")]);
  t("rest between shifts: clock out of call-back, shift starts <=6h later", has(ls, "g", "Rest Between Shifts"));
  ls = lines([E("h", "2026-10-13", "callback", 3.25, "09:49", "12:53"), E("i", "2026-10-14", "shift", 12, "05:38", "19:23")]);
  t("no rest premium when the shift starts >6h after the call-back", !ls.some(l => l.label.includes("Rest Between Shifts")));
  ls = lines([E("j", "2026-10-14", "callback", 1.5, "05:30", "07:00"), E("k", "2026-10-14", "shift", 12, "07:00", "19:23")]);
  t("no rest premium when a call-in rolls straight into the shift (no clock-out)", !ls.some(l => l.label.includes("Rest Between Shifts")));

  const wd = (date, start, end) => has(lines([E("w", date, "callback", 2, start, end)]), "w", "weekend diff");
  t("weekend diff: Fri 20:00 start unpaid", !wd("2026-10-09", "20:00", "22:00"));
  t("weekend diff: Fri 20:45 start paid", wd("2026-10-09", "20:45", "22:45"));
  t("weekend diff: Sat 02:28 start paid", wd("2026-10-10", "02:28", "04:28"));
  t("weekend diff: Sun 23:25 start (runs into Mon) paid", wd("2026-10-11", "23:25", "01:25"));
  t("weekend diff: Mon 05:38 start unpaid", !wd("2026-10-12", "05:38", "07:38"));

  run("entries = " + JSON.stringify([E("m", "2026-09-08", "shift", 12, "07:00", "19:23"), E("n", "2026-09-15", "shift", 12, "07:00", "19:23")]));
  const cw = JSON.parse(run("JSON.stringify(computeWeeks().map(w => [w.start, w.certPay]))"));
  t("certification pay stops for weeks starting after the end date", cw[0][1] === 20.77 && cw[1][1] === 0);
  run("settings = " + base);
}

console.log("\n" + (failures ? failures + " of " + checks + " checks FAILED" : "all " + checks + " checks passed"));
process.exit(failures ? 1 : 0);
