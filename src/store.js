import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Single-file JSON store. State lives in memory; every mutation is serialized
 * through a queue and persisted with write-to-temp + fsync + rename so the data
 * file is always either the old or the new complete document.
 */
export class JsonFileStore {
  constructor(file, { initial, validate }) {
    this.file = path.resolve(file);
    this.initial = initial;
    this.validate = validate;
    this.state = null;
    this.queue = Promise.resolve();
  }

  async load() {
    let raw;
    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      this.state = this.initial();
      await this.#write(this.state);
      return this;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Data file ${this.file} is not valid JSON; refusing to start (fix or move it aside)`);
    }
    const problem = this.validate(parsed);
    if (problem) throw new Error(`Data file ${this.file} has invalid shape: ${problem}`);
    this.state = parsed;
    return this;
  }

  /** Current state. Treat as read-only. */
  get data() {
    return this.state;
  }

  /**
   * fn(current) must not mutate `current`; it returns { next, result }.
   * Memory is only updated after the new document is durably on disk.
   */
  mutate(fn) {
    const run = this.queue.then(async () => {
      const { next, result } = fn(this.state);
      await this.#write(next);
      this.state = next;
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  flush() {
    return this.queue;
  }

  async #write(data) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const handle = await fs.open(tmp, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify(data, null, 1));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await fs.rename(tmp, this.file);
          return;
        } catch (err) {
          // Windows can briefly lock the target (antivirus, indexers).
          if (attempt >= 5 || !["EPERM", "EBUSY", "EACCES"].includes(err.code)) throw err;
          await sleep(20 * (attempt + 1));
        }
      }
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
  }
}