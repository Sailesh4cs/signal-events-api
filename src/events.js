import { badRequest, isPlainObject } from "./http.js";

export const EVENT_NAME_RE = /^[a-z][a-z0-9_.:-]{0,63}$/;
const PROP_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const EVENT_ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;
const AGG_NAME_RE = /^[a-z][a-z0-9-]{1,49}$/;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY = 864e5;
const HOUR = 36e5;
export const MAX_RANGE_DAYS = 366;
export const MAX_BUCKETS = 2000;
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_EVENT_AGE_MS = 365 * DAY;
export const METRICS = ["count", "unique_users", "sum", "avg", "min", "max"];
const EVENT_FIELDS = ["name", "timestamp", "userId", "value", "properties", "eventId"];
const AGG_FIELDS = ["name", "description", "eventName", "metric", "groupBy"];

function validCalendar(y, m, d) {
  const dt = new Date(Date.UTC(+y, +m - 1, +d));
  return dt.getUTCFullYear() === +y && dt.getUTCMonth() === +m - 1 && dt.getUTCDate() === +d;
}

/** Parses strict ISO-8601 date-time with explicit timezone. Returns epoch ms or null. */
export function parseDateTime(value) {
  if (typeof value !== "string") return null;
  const m = DATETIME_RE.exec(value);
  if (!m || !validCalendar(m[1], m[2], m[3]) || +m[4] > 23 || +m[5] > 59 || (m[6] && +m[6] > 59)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function parseBoundary(value, isEnd) {
  const d = DATE_RE.exec(value);
  if (d) {
    if (!validCalendar(d[1], d[2], d[3])) return null;
    const start = Date.UTC(+d[1], +d[2] - 1, +d[3]);
    return isEnd ? start + DAY : start; // date-only `to` includes that whole day
  }
  return parseDateTime(value);
}

export function validateEvent(raw, index, now) {
  const p = index === null ? "" : `events[${index}].`;
  const errors = [];
  if (!isPlainObject(raw)) return { errors: [{ field: p || "(body)", message: "must be an object" }] };
  for (const key of Object.keys(raw)) if (!EVENT_FIELDS.includes(key)) errors.push({ field: p + key, message: "unknown field" });
  if (typeof raw.name !== "string" || !EVENT_NAME_RE.test(raw.name)) {
    errors.push({ field: p + "name", message: "is required and must match ^[a-z][a-z0-9_.:-]{0,63}$" });
  }
  let ts = now;
  if (raw.timestamp !== undefined) {
    ts = parseDateTime(raw.timestamp);
    if (ts === null) errors.push({ field: p + "timestamp", message: "must be an ISO-8601 date-time with timezone, e.g. 2026-03-01T12:00:00Z" });
    else if (ts > now + FUTURE_SKEW_MS) errors.push({ field: p + "timestamp", message: "must not be more than 5 minutes in the future" });
    else if (ts < now - MAX_EVENT_AGE_MS) errors.push({ field: p + "timestamp", message: "must not be older than 365 days" });
  }
  if (raw.userId !== undefined && raw.userId !== null && (typeof raw.userId !== "string" || raw.userId.length < 1 || raw.userId.length > 128)) {
    errors.push({ field: p + "userId", message: "must be a string of 1-128 characters" });
  }
  if (raw.eventId !== undefined && (typeof raw.eventId !== "string" || !EVENT_ID_RE.test(raw.eventId))) {
    errors.push({ field: p + "eventId", message: "must match ^[A-Za-z0-9_.:-]{1,100}$" });
  }
  if (raw.value !== undefined && raw.value !== null && (typeof raw.value !== "number" || !Number.isFinite(raw.value))) {
    errors.push({ field: p + "value", message: "must be a finite number" });
  }
  if (raw.properties !== undefined) {
    if (!isPlainObject(raw.properties)) errors.push({ field: p + "properties", message: "must be an object" });
    else {
      const entries = Object.entries(raw.properties);
      if (entries.length > 20) errors.push({ field: p + "properties", message: "must have at most 20 keys" });
      for (const [k, v] of entries) {
        if (!PROP_KEY_RE.test(k)) errors.push({ field: `${p}properties.${k.slice(0, 40)}`, message: "invalid key" });
        else if (!(v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.length <= 500))) {
          errors.push({ field: `${p}properties.${k}`, message: "value must be string(<=500), finite number, boolean or null" });
        }
      }
    }
  }
  if (errors.length) return { errors };
  return {
    event: {
      eventId: raw.eventId ?? null,
      name: raw.name,
      timestamp: new Date(ts).toISOString(),
      userId: raw.userId ?? null,
      value: raw.value ?? null,
      properties: raw.properties ?? {},
    },
  };
}

export function parseRange(params, now) {
  const errors = [];
  const fromRaw = params.get("from");
  const toRaw = params.get("to");
  // Default end includes events stamped up to the accepted future clock skew.
  let to = now + FUTURE_SKEW_MS;
  let from;
  if (toRaw !== null) {
    to = parseBoundary(toRaw, true);
    if (to === null) errors.push({ field: "to", message: "must be YYYY-MM-DD or ISO-8601 date-time with timezone" });
  }
  if (fromRaw !== null) {
    from = parseBoundary(fromRaw, false);
    if (from === null) errors.push({ field: "from", message: "must be YYYY-MM-DD or ISO-8601 date-time with timezone" });
  } else if (to !== null) {
    from = to - 7 * DAY;
  }
  if (!errors.length) {
    if (from >= to) errors.push({ field: "from", message: "must be before to" });
    else if (to - from > MAX_RANGE_DAYS * DAY) errors.push({ field: "to", message: `range must not exceed ${MAX_RANGE_DAYS} days` });
  }
  return { errors, range: errors.length ? null : { from, to } };
}

export function rangeJson(range) {
  return { from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString() };
}

export function checkParams(params, allowed) {
  const errors = [];
  for (const key of new Set(params.keys())) if (!allowed.includes(key)) errors.push({ field: key, message: "unknown query parameter" });
  return errors;
}

export function intParam(params, name, fallback, min, max, errors) {
  const raw = params.get(name);
  if (raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(raw) || +raw < min || +raw > max) {
    errors.push({ field: name, message: `must be an integer ${min}-${max}` });
    return fallback;
  }
  return +raw;
}

export function nameParam(params, errors) {
  const name = params.get("name");
  if (name === null || name === "") return null;
  if (!EVENT_NAME_RE.test(name)) errors.push({ field: "name", message: "invalid event name" });
  return name;
}

export function inRange(events, range, name) {
  return events.filter((e) => {
    const t = Date.parse(e.timestamp);
    return t >= range.from && t < range.to && (!name || e.name === name);
  });
}

function round(n) {
  return Math.round(n * 1e6) / 1e6;
}

export function computeMetric(metric, events) {
  if (metric === "count") return events.length;
  if (metric === "unique_users") {
    const users = new Set();
    for (const e of events) if (e.userId) users.add(e.userId);
    return users.size;
  }
  let sum = 0, n = 0, min = Infinity, max = -Infinity;
  for (const e of events) {
    if (e.value === null) continue;
    sum += e.value; n++;
    if (e.value < min) min = e.value;
    if (e.value > max) max = e.value;
  }
  if (metric === "sum") return round(sum);
  if (!n) return null;
  if (metric === "avg") return round(sum / n);
  return metric === "min" ? min : max;
}

export function bucketize(events, range, interval, metric = "count") {
  const step = interval === "hour" ? HOUR : DAY;
  const start = Math.floor(range.from / step) * step;
  const count = Math.ceil((range.to - start) / step);
  const groups = Array.from({ length: count }, () => []);
  for (const e of events) groups[Math.floor((Date.parse(e.timestamp) - start) / step)].push(e);
  return groups.map((evs, i) => ({ key: new Date(start + i * step).toISOString(), value: computeMetric(metric, evs), events: evs.length }));
}

export function parseInterval(params, range, errors) {
  const interval = params.get("interval") || "day";
  if (!["hour", "day"].includes(interval)) {
    errors.push({ field: "interval", message: "must be hour or day" });
    return interval;
  }
  if (range && bucketCount(range, interval) > MAX_BUCKETS) {
    errors.push({ field: "interval", message: `range produces more than ${MAX_BUCKETS} buckets; use a larger interval or shorter range` });
  }
  return interval;
}

function bucketCount(range, interval) {
  const step = interval === "hour" ? HOUR : DAY;
  return Math.ceil((range.to - Math.floor(range.from / step) * step) / step);
}

export function summarize(events) {
  const byName = new Map();
  const users = new Set();
  let totalValue = 0;
  for (const e of events) {
    let s = byName.get(e.name);
    if (!s) byName.set(e.name, (s = { name: e.name, count: 0, users: new Set(), sumValue: 0 }));
    s.count++;
    if (e.userId) { s.users.add(e.userId); users.add(e.userId); }
    if (e.value !== null) { s.sumValue += e.value; totalValue += e.value; }
  }
  return {
    totalEvents: events.length,
    uniqueUsers: users.size,
    totalValue: round(totalValue),
    byName: [...byName.values()]
      .map((s) => ({ name: s.name, count: s.count, uniqueUsers: s.users.size, sumValue: round(s.sumValue) }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  };
}

export function validateAggregation(body) {
  if (!isPlainObject(body)) throw badRequest("Body must be a JSON object");
  const errors = [];
  for (const key of Object.keys(body)) if (!AGG_FIELDS.includes(key)) errors.push({ field: key, message: "unknown field" });
  if (typeof body.name !== "string" || !AGG_NAME_RE.test(body.name)) errors.push({ field: "name", message: "is required and must match ^[a-z][a-z0-9-]{1,49}$" });
  if (body.description !== undefined && (typeof body.description !== "string" || body.description.length > 200)) errors.push({ field: "description", message: "must be a string of at most 200 characters" });
  if (body.eventName !== undefined && body.eventName !== null && (typeof body.eventName !== "string" || !EVENT_NAME_RE.test(body.eventName))) errors.push({ field: "eventName", message: "must be a valid event name or null" });
  if (!METRICS.includes(body.metric)) errors.push({ field: "metric", message: `is required; one of ${METRICS.join(", ")}` });
  const g = body.groupBy;
  if (g !== undefined && g !== null && !(typeof g === "string" && (["name", "userId", "hour", "day"].includes(g) || /^property\.[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(g)))) {
    errors.push({ field: "groupBy", message: "must be one of name, userId, hour, day, property.<key> or null" });
  }
  if (errors.length) throw badRequest("Invalid aggregation", errors);
  return {
    name: body.name,
    description: (body.description ?? "").trim(),
    eventName: body.eventName ?? null,
    metric: body.metric,
    groupBy: g ?? null,
  };
}

export function runAggregation(def, allEvents, range) {
  const events = inRange(allEvents, range, def.eventName);
  if (!def.groupBy) return { value: computeMetric(def.metric, events), events: events.length };
  if (def.groupBy === "hour" || def.groupBy === "day") {
    return { groups: bucketize(events, range, def.groupBy, def.metric) };
  }
  const keyOf = def.groupBy === "name" ? (e) => e.name
    : def.groupBy === "userId" ? (e) => e.userId
    : (e) => e.properties[def.groupBy.slice("property.".length)];
  const map = new Map();
  for (const e of events) {
    const raw = keyOf(e);
    const key = raw === undefined || raw === null ? "(none)" : String(raw);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(e);
  }
  const groups = [...map.entries()]
    .map(([key, evs]) => ({ key, value: computeMetric(def.metric, evs), events: evs.length }))
    .sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity) || a.key.localeCompare(b.key));
  return { groups: groups.slice(0, 100), totalGroups: groups.length };
}

export const DEFAULT_AGGREGATIONS = [
  { name: "events-per-day", description: "All events per UTC day", eventName: null, metric: "count", groupBy: "day" },
  { name: "top-events", description: "Event volume by name", eventName: null, metric: "count", groupBy: "name" },
  { name: "active-users", description: "Distinct users across all events", eventName: null, metric: "unique_users", groupBy: null },
];