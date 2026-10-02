import { randomBytes } from "node:crypto";

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new ApiError(400, "validation_error", message, details);

const BASE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

export function sendJson(res, status, payload, headers = {}) {
  if (res.writableEnded || res.destroyed) return;
  const body = payload === undefined ? "" : JSON.stringify(payload);
  res.writeHead(status, {
    ...BASE_HEADERS,
    "Cache-Control": "no-store",
    ...(body ? { "Content-Type": "application/json; charset=utf-8" } : {}),
    "Content-Length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

export function sendError(res, err) {
  const status = err instanceof ApiError ? err.status : 500;
  const error = err instanceof ApiError
    ? { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) }
    : { code: "internal_error", message: "An unexpected error occurred" };
  sendJson(res, status, { error }, err.headers || {});
}

export function sendHtml(res, template) {
  const nonce = randomBytes(16).toString("base64");
  const body = template.replaceAll("{{NONCE}}", nonce);
  res.writeHead(200, {
    ...BASE_HEADERS,
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "Content-Security-Policy": [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      "connect-src 'self'",
      "img-src 'self' data:",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
  });
  res.end(body);
}

export function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers["content-type"] || "");
    if (!/^application\/json(\s*;|$)/i.test(type)) {
      req.resume();
      reject(new ApiError(415, "unsupported_media_type", "Content-Type must be application/json"));
      return;
    }
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      reject(new ApiError(413, "payload_too_large", `Request body exceeds ${limit} bytes`));
      return;
    }
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      if (tooLarge) return reject(new ApiError(413, "payload_too_large", `Request body exceeds ${limit} bytes`));
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return reject(badRequest("Request body must not be empty"));
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new ApiError(400, "invalid_json", "Request body is not valid JSON"));
      }
    });
  });
}

export function methodNotAllowed(allowed) {
  const err = new ApiError(405, "method_not_allowed", `Method not allowed. Allowed: ${allowed.join(", ")}`);
  err.headers = { Allow: allowed.join(", ") };
  return err;
}

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}