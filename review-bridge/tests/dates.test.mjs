import assert from "node:assert/strict";
import test from "node:test";

import { localTimestamp } from "../utils/dates.mjs";

// The same moment in each zone, with the whole, the half-hour and the negative offsets git prints.
test("a moment is printed in local time with its offset, as git log --date=iso prints it", (t) => {
  const zone = process.env.TZ;
  t.after(() => { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; });
  const moment = "2026-11-04T05:33:27.812Z";
  for (const [name, expected] of [
    ["Asia/Taipei", "2026-11-04 13:33:27 +0800"],
    ["Asia/Kolkata", "2026-11-04 11:03:27 +0530"],
    ["America/New_York", "2026-11-04 00:33:27 -0500"],
    ["UTC", "2026-11-04 05:33:27 +0000"],
  ]) {
    process.env.TZ = name;
    assert.equal(localTimestamp(moment), expected, name);
    assert.equal(localTimestamp(new Date(moment)), expected, name + ": a Date, as the records return it");
  }
  assert.throws(() => localTimestamp("not a date"), /Invalid date to print/);
});
