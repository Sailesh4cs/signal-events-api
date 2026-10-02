import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ApiError, badRequest, readJson, sendError, sendHtml, sendJson, methodNotAllowed, isPlainObject } from "./http.js";
import { JsonFileStore } from "./store.js";
import {
  validateEvent, parseRange, rangeJson, checkParams, intParam, nameParam, inRange, bucketize, parseInterval,
  summarize, validateAggregation, runAggregation, DEFAULT_AGGREGATIONS, METRICS,
} from "./events.js";

const DASHBOARD = readFileSync(fileURLToPath(new URL("../public/index.html", import.meta.url)), "utf8");

function validateShape(doc) {
  if (!isPlainObject(doc) || !Array.isArray(doc.events) || !Array.isArray(doc.aggregations)) return "expected { events: [], aggregations: [] }";
  return null;
}

function fail(errors, message = "Invalid query parameters") {
  if (errors.length) throw badRequest(message, errors);
}

export async function createApp(config) {
  const now = config.now || (() => Date.now());
  const store = await new JsonFileStore(config.dataFile, {
    initial: () => ({
      version: 1,
      events: [],
      aggregations: DEFAULT_AGGREGATIONS.map((a) => ({ ...a, createdAt: new Date(now()).toISOString() })),
    }),
    validate: validateShape,
  }).load();

  function rangeFrom(params) {
    const { errors, range } = parseRange(params, now());
    fail(errors);
    return range;
  }

  async function ingest(req, res) {
    const body = await readJson(req, config.bodyLimit);
    const isBatch = isPlainObject(body) && Object.prototype.hasOwnProperty.call(body, "events");
    if (isBatch && Object.keys(body).length !== 1) throw badRequest("Batch body must contain only an events array");
    const raws = isBatch ? body.events : [body];
    if (!Array.isArray(raws) || raws.length === 0) throw badRequest("events must be a non-empty array");
    if (raws.length > config.maxBatch) throw badRequest(`Batch exceeds maximum of ${config.maxBatch} events`);
    const t = now();
    const errors = [];
    const valid = [];
    raws.forEach((raw, i) => {
      const r = validateEvent(raw, isBatch ? i : null, t);
      if (r.errors) errors.push(...r.errors);
      else valid.push(r.event);
    });
    if (errors.length) throw badRequest("Invalid event payload; no events were stored", errors.slice(0, 50));

    const result = await store.mutate((cur) => {
      const seen = new Set();
      for (const e of cur.events) if (e.eventId) seen.add(e.eventId);
      const receivedAt = new Date(t).toISOString();
      const added = [];
      let duplicates = 0;
      for (const e of valid) {
        if (e.eventId && seen.has(e.eventId)) { duplicates++; continue; }
        if (e.eventId) seen.add(e.eventId);
        added.push({ id: randomUUID(), ...e, receivedAt });
      }
      let events = added.length ? cur.events.concat(added) : cur.events;
      const evicted = Math.max(0, events.length - config.maxEvents);
      if (evicted) events = events.slice(evicted);
      return { next: { ...cur, events }, result: { accepted: added.length, duplicates, evicted, ids: added.map((e) => e.id) } };
    });
    return sendJson(res, result.accepted ? 201 : 200, { data: result });
  }

  async function handle(req, res, url) {
    const { pathname, searchParams: params } = url;
    const method = req.method;
    const only = (...m) => { if (!m.includes(method)) throw methodNotAllowed(m); };

    if (pathname === "/" || pathname === "/index.html") {
      if (method !== "GET" && method !== "HEAD") throw methodNotAllowed(["GET"]);
      return sendHtml(res, DASHBOARD);
    }
    if (pathname === "/health") {
      only("GET");
      return sendJson(res, 200, { status: "ok", events: store.data.events.length, time: new Date(now()).toISOString() });
    }
    if (pathname === "/api/events") {
      if (method === "POST") return ingest(req, res);
      only("GET", "POST");
      const errors = checkParams(params, ["name", "userId", "from", "to", "limit", "offset"]);
      const limit = intParam(params, "limit", 100, 1, 500, errors);
      const offset = intParam(params, "offset", 0, 0, 10_000_000, errors);
      const name = nameParam(params, errors);
      fail(errors);
      const range = rangeFrom(params);
      const userId = params.get("userId");
      const matched = inRange(store.data.events, range, name).filter((e) => !userId || e.userId === userId);
      matched.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
      return sendJson(res, 200, { data: matched.slice(offset, offset + limit), page: { total: matched.length, limit, offset }, range: rangeJson(range) });
    }
    if (pathname === "/api/reports/summary") {
      only("GET");
      const errors = checkParams(params, ["from", "to", "name"]);
      const name = nameParam(params, errors);
      fail(errors);
      const range = rangeFrom(params);
      return sendJson(res, 200, { data: { range: rangeJson(range), ...summarize(inRange(store.data.events, range, name)) } });
    }
    if (pathname === "/api/reports/timeseries") {
      only("GET");
      const errors = checkParams(params, ["from", "to", "name", "interval"]);
      const name = nameParam(params, errors);
      fail(errors);
      const range = rangeFrom(params);
      const interval = parseInterval(params, range, errors);
      fail(errors);
      const buckets = bucketize(inRange(store.data.events, range, name), range, interval).map(({ key, events }) => ({ start: key, count: events }));
      return sendJson(res, 200, { data: { range: rangeJson(range), interval, name, buckets } });
    }
    if (pathname === "/api/aggregations") {
      if (method === "GET") {
        fail(checkParams(params, []));
        return sendJson(res, 200, { data: store.data.aggregations, metrics: METRICS });
      }
      if (method === "POST") {
        const def = validateAggregation(await readJson(req, config.bodyLimit));
        const created = await store.mutate((cur) => {
          if (cur.aggregations.some((a) => a.name === def.name)) throw new ApiError(409, "conflict", `Aggregation ${def.name} already exists`);
          if (cur.aggregations.length >= 100) throw new ApiError(409, "limit_reached", "At most 100 aggregations may be defined");
          const agg = { ...def, createdAt: new Date(now()).toISOString() };
          return { next: { ...cur, aggregations: [...cur.aggregations, agg] }, result: agg };
        });
        return sendJson(res, 201, { data: created }, { Location: `/api/aggregations/${created.name}` });
      }
      throw methodNotAllowed(["GET", "POST"]);
    }
    const agg = /^\/api\/aggregations\/([a-z][a-z0-9-]{1,49})(\/run)?$/.exec(pathname);
    if (agg) {
      const [, name, run] = agg;
      const find = () => {
        const def = store.data.aggregations.find((a) => a.name === name);
        if (!def) throw new ApiError(404, "not_found", "Aggregation not found");
        return def;
      };
      if (run) {
        only("GET");
        const def = find();
        const errors = checkParams(params, ["from", "to"]);
        fail(errors);
        const range = rangeFrom(params);
        if (def.groupBy === "hour" || def.groupBy === "day") {
          parseInterval(new URLSearchParams({ interval: def.groupBy }), range, errors);
          fail(errors);
        }
        return sendJson(res, 200, { data: { aggregation: def, range: rangeJson(range), result: runAggregation(def, store.data.events, range) } });
      }
      if (method === "GET") return sendJson(res, 200, { data: find() });
      if (method === "DELETE") {
        await store.mutate((cur) => {
          if (!cur.aggregations.some((a) => a.name === name)) throw new ApiError(404, "not_found", "Aggregation not found");
          return { next: { ...cur, aggregations: cur.aggregations.filter((a) => a.name !== name) } };
        });
        return sendJson(res, 204);
      }
      throw methodNotAllowed(["GET", "DELETE"]);
    }
    throw new ApiError(404, "not_found", "Route not found");
  }

  const server = createServer(async (req, res) => {
    const started = process.hrtime.bigint();
    let url;
    try {
      url = new URL(req.url, "http://localhost");
      await handle(req, res, url);
    } catch (err) {
      if (!(err instanceof ApiError)) console.error("Unhandled error:", err);
      sendError(res, err);
    } finally {
      if (config.logRequests) {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        console.log(JSON.stringify({ t: new Date().toISOString(), method: req.method, path: url?.pathname ?? req.url, status: res.statusCode, ms: Math.round(ms * 10) / 10 }));
      }
    }
  });
  server.requestTimeout = config.requestTimeout;
  server.headersTimeout = Math.min(config.requestTimeout, 10_000);
  return { server, store };
}