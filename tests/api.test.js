import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";

const NOW = Date.parse("2026-03-10T12:00:00Z");
const dir = await mkdtemp(path.join(tmpdir(), "signal-test-"));
after(async () => { await rm(dir, { recursive: true, force: true }); });

async function start(dataFile, overrides = {}) {
  const app = await createApp({ dataFile, bodyLimit: 64 * 1024, maxBatch: 50, maxEvents: 10_000, requestTimeout: 5000, logRequests: false, now: () => NOW, ...overrides });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text };
  };
  return { ...app, base, call, stop: () => new Promise((r) => { app.server.close(r); app.server.closeIdleConnections(); }) };
}

const at = (iso) => `2026-03-${iso}Z`;

describe("signal events API", () => {
  let app;
  before(async () => {
    app = await start(path.join(dir, "main.json"));
    const res = await app.call("POST", "/api/events", { events: [
      { name: "page.view", timestamp: at("08T10:00:00"), userId: "u1", properties: { plan: "pro", path: "/" } },
      { name: "page.view", timestamp: at("08T11:30:00"), userId: "u2", properties: { plan: "free" } },
      { name: "page.view", timestamp: at("09T09:00:00"), userId: "u1" },
      { name: "purchase", timestamp: at("09T09:05:00"), userId: "u1", value: 49.5, properties: { plan: "pro" } },
      { name: "purchase", timestamp: "2026-03-10T08:00:00+02:00", userId: "u3", value: 10.25, properties: { plan: "free" } },
      { name: "signup", timestamp: "2026-02-01T00:00:00Z", userId: "u9" },
    ] });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.accepted, 6);
  });
  after(async () => { await app.stop(); });

  test("health and dashboard with CSP", async () => {
    assert.equal((await app.call("GET", "/health")).body.events, 6);
    const page = await app.call("GET", "/");
    assert.equal(page.status, 200);
    const csp = page.headers.get("content-security-policy");
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)[1];
    assert.ok(page.body.includes(`<script nonce="${nonce}">`));
    assert.ok(csp.includes("default-src 'none'"));
    assert.ok(!page.body.includes("innerHTML"));
  });

  test("single event ingestion defaults timestamp to now and normalizes", async () => {
    const res = await app.call("POST", "/api/events", { name: "app.open", userId: "u5" });
    assert.equal(res.status, 201);
    const list = await app.call("GET", "/api/events?name=app.open&from=2026-03-10&to=2026-03-10");
    assert.equal(list.body.data.length, 1);
    assert.equal(list.body.data[0].timestamp, new Date(NOW).toISOString());
    assert.equal(list.body.data[0].id, res.body.data.ids[0]);
  });

  test("idempotent eventId deduplication", async () => {
    const first = await app.call("POST", "/api/events", { events: [{ name: "dedupe.test", eventId: "evt-1" }, { name: "dedupe.test", eventId: "evt-1" }] });
    assert.equal(first.status, 201);
    assert.deepEqual([first.body.data.accepted, first.body.data.duplicates], [1, 1]);
    const again = await app.call("POST", "/api/events", { name: "dedupe.test", eventId: "evt-1" });
    assert.equal(again.status, 200);
    assert.equal(again.body.data.accepted, 0);
  });

  test("rejects invalid events atomically", async () => {
    const before = (await app.call("GET", "/health")).body.events;
    const cases = [
      [{ name: "Bad Name" }, "name"],
      [{}, "name"],
      [{ name: "x", timestamp: "2026-03-01" }, "timestamp"],
      [{ name: "x", timestamp: "2026-02-30T00:00:00Z" }, "timestamp"],
      [{ name: "x", timestamp: "2026-03-01T25:00:00Z" }, "timestamp"],
      [{ name: "x", timestamp: "2026-03-10T13:00:00Z" }, "timestamp"],
      [{ name: "x", timestamp: "2024-01-01T00:00:00Z" }, "timestamp"],
      [{ name: "x", value: "12" }, "value"],
      [{ name: "x", properties: { nested: { a: 1 } } }, "properties.nested"],
      [{ name: "x", properties: [] }, "properties"],
      [{ name: "x", properties: { "bad-key": 1 } }, "properties.bad-key"],
      [{ name: "x", extra: true }, "extra"],
      [{ name: "x", userId: "" }, "userId"],
      [{ name: "x", eventId: "has space" }, "eventId"],
    ];
    for (const [body, field] of cases) {
      const res = await app.call("POST", "/api/events", body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.ok(res.body.error.details.some((d) => d.field === field), `${field}: ${JSON.stringify(res.body.error.details)}`);
    }
    const mixed = await app.call("POST", "/api/events", { events: [{ name: "ok.one" }, { name: "BAD" }] });
    assert.equal(mixed.status, 400);
    assert.equal(mixed.body.error.details[0].field, "events[1].name");
    assert.equal((await app.call("POST", "/api/events", { events: [] })).status, 400);
    assert.equal((await app.call("POST", "/api/events", { events: [{ name: "a" }], other: 1 })).status, 400);
    const tooMany = await app.call("POST", "/api/events", { events: Array.from({ length: 51 }, () => ({ name: "a" })) });
    assert.equal(tooMany.status, 400);
    assert.equal((await app.call("POST", "/api/events", "[oops")).body.error.code, "invalid_json");
    const wrongType = await fetch(app.base + "/api/events", { method: "POST", body: "{}", headers: { "Content-Type": "text/plain" } });
    assert.equal(wrongType.status, 415);
    const huge = await app.call("POST", "/api/events", { name: "a", properties: { s: "x".repeat(70_000) } });
    assert.equal(huge.status, 413);
    assert.equal((await app.call("GET", "/health")).body.events, before, "no partial writes");
    assert.equal((await app.call("DELETE", "/api/events")).status, 405);
  });

  test("date range validation", async () => {
    const bad = [
      "from=2026-13-01", "from=2026-02-30", "to=yesterday", "from=2026-03-01T10:00:00", // missing tz
      "from=2026-03-10&to=2026-03-01", "from=2025-01-01&to=2026-03-01", "from=2026-03-05T00:00:00Z&to=2026-03-05T00:00:00Z",
    ];
    for (const q of bad) {
      const res = await app.call("GET", "/api/reports/summary?" + q);
      assert.equal(res.status, 400, q);
      assert.equal(res.body.error.code, "validation_error");
    }
    const ok = await app.call("GET", "/api/reports/summary?from=2026-03-08&to=2026-03-08");
    assert.deepEqual(ok.body.data.range, { from: "2026-03-08T00:00:00.000Z", to: "2026-03-09T00:00:00.000Z" });
    const def = await app.call("GET", "/api/reports/summary");
    assert.deepEqual(def.body.data.range, { from: "2026-03-03T12:05:00.000Z", to: "2026-03-10T12:05:00.000Z" });
    assert.equal((await app.call("GET", "/api/reports/timeseries?from=2026-01-01&to=2026-03-31&interval=hour")).status, 400, "too many buckets");
    assert.equal((await app.call("GET", "/api/reports/timeseries?interval=week")).status, 400);
    assert.equal((await app.call("GET", "/api/reports/summary?bogus=1")).status, 400);
    assert.equal((await app.call("GET", "/api/events?limit=0")).status, 400);
    assert.equal((await app.call("GET", "/api/events?name=BAD")).status, 400);
  });

  test("summary and timeseries reports", async () => {
    const s = (await app.call("GET", "/api/reports/summary?from=2026-03-08&to=2026-03-10T07:00:00Z")).body.data;
    assert.equal(s.totalEvents, 5);
    assert.equal(s.uniqueUsers, 3);
    assert.equal(s.totalValue, 59.75);
    assert.deepEqual(s.byName.map((r) => [r.name, r.count]), [["page.view", 3], ["purchase", 2]]);
    const filtered = (await app.call("GET", "/api/reports/summary?from=2026-03-08&to=2026-03-10T07:00:00Z&name=purchase")).body.data;
    assert.equal(filtered.totalEvents, 2);

    const ts = (await app.call("GET", "/api/reports/timeseries?from=2026-03-07&to=2026-03-09&interval=day")).body.data;
    assert.deepEqual(ts.buckets, [
      { start: "2026-03-07T00:00:00.000Z", count: 0 },
      { start: "2026-03-08T00:00:00.000Z", count: 2 },
      { start: "2026-03-09T00:00:00.000Z", count: 2 },
    ]);
    const hourly = (await app.call("GET", "/api/reports/timeseries?from=2026-03-08T10:00:00Z&to=2026-03-08T12:00:00Z&interval=hour&name=page.view")).body.data;
    assert.deepEqual(hourly.buckets.map((b) => b.count), [1, 1]);

    const list = await app.call("GET", "/api/events?from=2026-03-01&to=2026-03-10&userId=u1&limit=2");
    assert.equal(list.body.page.total, 3);
    assert.equal(list.body.data.length, 2);
    assert.equal(list.body.data[0].name, "purchase", "newest first");
  });

  test("named aggregations: CRUD, run, validation", async () => {
    const defaults = (await app.call("GET", "/api/aggregations")).body.data.map((a) => a.name);
    assert.deepEqual(defaults, ["events-per-day", "top-events", "active-users"]);

    const created = await app.call("POST", "/api/aggregations", { name: "revenue-by-plan", eventName: "purchase", metric: "sum", groupBy: "property.plan", description: "Revenue split" });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get("location"), "/api/aggregations/revenue-by-plan");
    assert.equal((await app.call("POST", "/api/aggregations", { name: "revenue-by-plan", metric: "count" })).status, 409);

    const range = "from=2026-03-01&to=2026-03-10";
    let run = (await app.call("GET", `/api/aggregations/revenue-by-plan/run?${range}`)).body.data;
    assert.deepEqual(run.result.groups.map((g) => [g.key, g.value]), [["pro", 49.5], ["free", 10.25]]);

    await app.call("POST", "/api/aggregations", { name: "avg-order", eventName: "purchase", metric: "avg" });
    run = (await app.call("GET", `/api/aggregations/avg-order/run?${range}`)).body.data;
    assert.deepEqual(run.result, { value: 29.875, events: 2 });

    run = (await app.call("GET", `/api/aggregations/active-users/run?from=2026-03-08&to=2026-03-09`)).body.data;
    assert.equal(run.result.value, 2);

    run = (await app.call("GET", `/api/aggregations/events-per-day/run?from=2026-03-08&to=2026-03-09`)).body.data;
    assert.deepEqual(run.result.groups.map((g) => g.value), [2, 2]);

    await app.call("POST", "/api/aggregations", { name: "users-by-hour", metric: "unique_users", groupBy: "hour" });
    assert.equal((await app.call("GET", "/api/aggregations/users-by-hour/run?from=2026-01-01&to=2026-03-31")).status, 400);

    for (const body of [
      { name: "X", metric: "count" }, { name: "ok-name", metric: "median" }, { name: "ok-name", metric: "count", groupBy: "color" },
      { name: "ok-name", metric: "count", eventName: "Bad" }, { name: "ok-name", metric: "count", extra: 1 },
    ]) assert.equal((await app.call("POST", "/api/aggregations", body)).status, 400, JSON.stringify(body));

    assert.equal((await app.call("GET", "/api/aggregations/missing-one/run")).status, 404);
    assert.equal((await app.call("GET", "/api/aggregations/revenue-by-plan/run?from=bad")).status, 400);
    assert.equal((await app.call("DELETE", "/api/aggregations/avg-order")).status, 204);
    assert.equal((await app.call("GET", "/api/aggregations/avg-order")).status, 404);
    assert.equal((await app.call("DELETE", "/api/aggregations/avg-order")).status, 404);
    assert.equal((await app.call("PUT", "/api/aggregations/top-events")).status, 405);
  });
});

describe("persistence", () => {
  test("events and aggregations survive restart; writes are atomic", async () => {
    const file = path.join(dir, "persist", "events.json");
    const first = await start(file);
    await Promise.all(Array.from({ length: 15 }, (_, i) => first.call("POST", "/api/events", { name: "load.test", userId: `u${i % 4}`, value: i, eventId: `e${i}` })));
    await first.call("POST", "/api/aggregations", { name: "load-sum", eventName: "load.test", metric: "sum" });
    await first.stop();

    const doc = JSON.parse(await readFile(file, "utf8"));
    assert.equal(doc.events.length, 15);
    assert.deepEqual((await readdir(path.dirname(file))).filter((f) => f.endsWith(".tmp")), []);

    const second = await start(file);
    const run = (await second.call("GET", "/api/aggregations/load-sum/run?from=2026-03-10&to=2026-03-10")).body.data;
    assert.deepEqual(run.result, { value: 105, events: 15 });
    const dup = await second.call("POST", "/api/events", { name: "load.test", eventId: "e3" });
    assert.equal(dup.body.data.duplicates, 1, "dedupe index rebuilt from disk");
    await second.stop();
  });

  test("retention cap evicts oldest events", async () => {
    const app = await start(path.join(dir, "cap.json"), { maxEvents: 100 });
    await app.call("POST", "/api/events", { events: Array.from({ length: 50 }, (_, i) => ({ name: "old", eventId: `o${i}` })) });
    await app.call("POST", "/api/events", { events: Array.from({ length: 50 }, () => ({ name: "mid" })) });
    const res = await app.call("POST", "/api/events", { events: Array.from({ length: 30 }, () => ({ name: "new" })) });
    assert.equal(res.body.data.evicted, 30);
    const s = (await app.call("GET", "/api/reports/summary")).body.data;
    assert.deepEqual(Object.fromEntries(s.byName.map((r) => [r.name, r.count])), { mid: 50, new: 30, old: 20 });
    await app.stop();
  });

  test("refuses to start on corrupt data", async () => {
    const bad = path.join(dir, "corrupt.json");
    await writeFile(bad, "garbage");
    await assert.rejects(start(bad), /not valid JSON/);
    await writeFile(bad, JSON.stringify({ events: [] }));
    await assert.rejects(start(bad), /invalid shape/);
  });
});