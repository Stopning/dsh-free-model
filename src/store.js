/**
 * Plugin-owned durable state: this fork's settings file.
 *
 * Storage is a plain JSON file under the harness home rather than a harness
 * service on purpose. The settings seam changed shape between the two kernel
 * lines this plugin has to run on (the older one exposes a registrable
 * namespace, the newer one projects volatile plugin config), and the storage
 * domain needs composition rows a bare profile may not mount. A file the plugin
 * owns behaves identically on both.
 *
 * Upstream's `stats.json`, `availability.json` and `catalog.json` are gone with
 * the model lane that filled them: the channels' per-request token ledger lives
 * in the absorbed pack, not here.
 *
 * Writes are coalesced and land through a temp file + rename, so a crash mid
 * write cannot leave a truncated store.
 *
 * @module src/store.js
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** Same resolution the harness home-paths helper uses: `$DSH_HOME` else `~/.dsh`. */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

export const DATA_DIR_NAME = 'our-free-model'

export class JsonStore {
  /**
   * @param {string} file - absolute path
   * @param {object} initial - value used when the file does not exist yet
   * @param {{log?: (message: string) => void}} [options] - write-failure channel;
   *   without it a flush that cannot write (disk full, permissions) stays silent
   */
  constructor(file, initial, { log } = {}) {
    this.file = file
    this.value = initial
    this.dirty = false
    this.timer = undefined
    this.disposed = false
    this.log = log
    this.writeFailed = false
    this.load()
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.value = { ...this.value, ...parsed }
      }
    } catch {
      // Absent is normal; unreadable is not. Keep the damaged file: without this
      // the next scheduled flush renames a fresh default over it and the user's
      // settings — the forward key, the acknowledged announcements — are gone with
      // nothing on disk to recover and nothing in the log to explain.
      try {
        if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`)
      } catch { /* a home we cannot write to is not this file's problem */ }
    }
  }

  get() {
    return this.value
  }

  /** Merge a patch in and schedule the write. Returns the new value. */
  update(patch) {
    if (this.disposed) return this.value
    this.value = { ...this.value, ...patch }
    this.schedule()
    return this.value
  }

  /** Mutate through a callback; used for read-modify-write on nested state. */
  edit(mutate) {
    if (this.disposed) return this.value
    const next = mutate(structuredClone(this.value))
    if (next !== undefined) this.value = next
    this.schedule()
    return this.value
  }

  schedule(delayMs = 800) {
    if (this.disposed) return
    this.dirty = true
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, delayMs)
    // Telemetry must never hold the process open.
    this.timer.unref?.()
  }

  flush() {
    if (!this.dirty || this.disposed) return
    this.dirty = false
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const temp = `${this.file}.${process.pid}.tmp`
      fs.writeFileSync(temp, JSON.stringify(this.value, undefined, 2), { mode: 0o600 })
      fs.renameSync(temp, this.file)
      this.writeFailed = false
    } catch (error) {
      // fail-soft: the next mutation retries, and nothing downstream depends on
      // it — but a home that cannot be written to loses every statistic and
      // every acknowledged setting, so the first failure gets said out loud
      // instead of rotting silently (repeat failures stay quiet: one line per
      // incident, not one per scheduled flush).
      // Re-arm `dirty`: it was cleared before the attempt, so dispose()'s
      // final flush would otherwise skip a write that never landed and drop
      // the session's last changes silently.
      this.dirty = true
      if (!this.writeFailed) {
        this.writeFailed = true
        this.log?.(`our-free-model: could not persist ${path.basename(this.file)} (${error?.message ?? error}); changes are kept in memory only`)
      }
    }
  }

  dispose() {
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined }
    // Persist what this generation changed, THEN lock the store: late callbacks
    // from a hot-reloaded-away generation (an in-flight feed poll, a pending
    // update check) must never write over the successor generation's state.
    // The disposal order makes this safe — the successor's stores are created
    // only after the previous generation's disposers have run.
    this.flush()
    this.disposed = true
    this.dirty = false
  }
}

/**
 * Everything this fork still persists.
 *
 * Upstream's keys (`enabled`, `exposeRegionModels`, `probeIntervalMinutes`,
 * `forward`, `defaultMaxTokens`, `streamRecovery`, `tokenSaver`, `aggregate`,
 * `combos`, `localOptimize`, the announcement/update fields,
 * `autoReloadWatch`, `distribution`) are gone with the lanes they configured. A
 * `settings.json` written by 2.1.0 keeps them as inert extra keys, because
 * `JsonStore.load` merges the file over these defaults — which is also why the
 * user's egress address and relay key survive the upgrade.
 */
export const SETTINGS_INITIAL = {
  version: 1,
  /** Route the pack's traffic through an outlet. `mode: 'subscription'` spawns a
   *  local mihomo that load-balances a Clash subscription; `mode: 'client'` dials
   *  one http/https/socks5/socks5h URL directly. Off by default — requests go
   *  straight out until this is turned on. */
  egress: { enabled: false, mode: 'subscription', url: '', mihomoPath: '' },
  /** Expose the channels' OpenAI gateway (the pack's loopback listener) to other
   *  machines under this plugin's own key. Off by default: a LAN listener is a
   *  door, and doors stay shut until asked for. */
  chanGateway: {
    relay: { enabled: false, host: '127.0.0.1', port: 18326, key: '' },
  },
}
