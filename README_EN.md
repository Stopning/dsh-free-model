# Model Access (dsh-free-model)

**A DSH plugin** (DeepSeek Harness · cordis bundle) · [中文](https://github.com/YpipaQ/dsh-free-model/blob/slim-channels-only/README.md)

[![npm](https://img.shields.io/npm/v/dsh-free-model.svg)](https://www.npmjs.com/package/dsh-free-model)
[![dsh plugin](https://img.shields.io/badge/dsh-plugin-4C8BF5)](#)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/YpipaQ/dsh-free-model/blob/slim-channels-only/LICENSE)

> A trimmed fork of [`Ebony-Vinyl/dsh-our-free-model`](https://github.com/Ebony-Vinyl/dsh-our-free-model) **2.1.0**.
> One lane survives: **bring your own account channels** — thirteen providers, plus a token dashboard,
> a per-request log and a local gateway. Upstream's anonymous free lane, the EAC co-paid lane, the
> aggregate lane, the token savers, the routing chains and the whole release/update channel are gone.

| | |
| --- | --- |
| npm | **`dsh-free-model`** (same as the repository) |
| Settings entry | **模型接入** in Chinese, **Model Access** in English |
| Loader entry id | `our-free-model` — the settings namespace and the state directory hang off this id, so they do **not** move when the package name changes |
| State directory | `~/.dsh/our-free-model/` (0600) |

## Install

**CLI (plain dsh web) — recommended**

```bash
dsh plugin --profile web add dsh-free-model
```

Then **restart dsh once**: the host half lives inside the process, so only a restart loads the new
`index.js`; the browser half just needs a page refresh. `--profile` takes the profile you actually use
(`web` by default).

**Desktop (DSHEAC AIO)**: install through the **in-app plugin manager**. The desktop build gates the
profile before booting web — it only lets through links dsh itself created under `.dsh-module-fallback`,
and any other symlink or junction in the profile tree makes it refuse to start
(`PROFILE_UPGRADE_REQUIRED`). So **do not use `link:` dependencies and do not hand-make junctions**.

**Switching from upstream**: upstream publishes as `dsh-our-free-model`. Both packages use the loader
entry id `our-free-model`, so they **cannot be installed at the same time**:

```bash
dsh plugin --profile web remove dsh-our-free-model
dsh plugin --profile web add dsh-free-model
```

The state directory and the entry id are unchanged in this fork, so **accounts, credentials and the
outlet address survive the switch**.

**Uninstall / roll back**

```bash
dsh plugin --profile web remove dsh-free-model          # uninstall
dsh plugin --profile web add dsh-our-free-model         # roll back to upstream 2.1.0
```

> ⚠️ **Do not copy the checkout into `node_modules/<package>/` by hand.** Measured on 2026-10-11: such a
> copy is replaced from the lockfile — or pruned outright — by the next `pnpm install` the plugin manager
> runs (installing or removing *any* other plugin triggers one). To pin it long-term, use the registry
> (this package) or a `file:` dependency on a CLI web profile.

## Quick start

1. After the restart open **Settings → 模型接入 / Model Access** and log into each channel you want
   (browser authorization; the account pool and credit lookups live on the same card).
2. Every channel card lets you switch models on and off one by one, plus **show all / hide all** —
   **they may all start hidden**, and hidden models never reach the model picker.
3. Back in the chat composer's model picker the channel models appear grouped per product; pick one.

## What survives

Four settings pages (down from nine):

| Page | What it does |
| --- | --- |
| **Free channels** | Thirteen account cards — CodeArts, CodeBuddy / WorkBuddy (CN + intl), LobsterAI, Qoder / Qoder CN, TRAE, Cline, Loomy, Raccoon, MiniMax Code, ZCode, Gemini: browser login, account pool, renewal, credit lookup and one-click claim, daily auto check-in, per-model switches, balance. |
| **Dashboard** | The pack's own per-request token ledger: today / all-time usage, average throughput, TTFT, cache hit rate, success rate, account pivot, per-model table. |
| **Request log** | Every request in detail: result, duration, TTFT, speed, token breakdown; hover a failed row for the reason. |
| **Gateway** | The pack's local OpenAI-compatible gateway (switch, endpoint, key, model count), this plugin's LAN relay (bind address/port, its own key, rotation), and the egress-outlet section. |

## What was removed and why

| Removed | Why |
| --- | --- |
| **Free models** page: the anonymous opencode lane + Kilo free pool | Third-party grey channel (client impersonation + pooled public credentials); can break at any time. |
| **EAC models** page: the GitHub-gated co-paid lane | Depends on the repository owner's gateway and a star grant. |
| **Aggregate** page (76 bring-your-own-key providers) | Served by the plugin's own adapter, which this fork removes. |
| **Token savers** page | The compaction pipeline runs inside that same adapter. |
| **Routing** page (combo fallback chains) | Same adapter. |
| Announcement centre, self-updater, hot reload | Upstream release signatures did not verify; and a fork should not let a remote party swap its bytes. |
| Local forward listener (18899) and the LAN forward | They forwarded the deleted lane. |
| `packages/standalone/`, `worker/`, `feed/`, `catalog/` | All three satellite products `import` the deleted lane; keeping them means shipping code that can never run. |

Sizes: `src/` went from **58 modules to 5** (`store/key/chan-relay/egress/trust`), the host `index.js`
from **2343 to 684 lines**, the browser half `client.js` from **5992 to 2538 lines**, and the offline
suites from 45 to **8**. Every `animation` and `@keyframes` rule is gone as well.

## Configuration

The only state file is `~/.dsh/our-free-model/settings.json` (0600); this fork reads three keys:

```json
{
  "egress": {
    "enabled": false,
    "mode": "subscription",
    "url": "",
    "mihomoPath": ""
  },
  "chanGateway": {
    "relay": { "enabled": false, "host": "127.0.0.1", "port": 18326, "key": "" }
  }
}
```

Other keys written by 2.1.0 (`enabled`, `forward`, `tokenSaver`, `aggregate`, `combos`,
`announcementsAcked`, …) are preserved but inert — `JsonStore` merges the file over the defaults, so
your outlet address and relay key survive an upgrade.

### HTTP surface

Everything goes through the trust fence, under `/api/our-free-model`:

```
GET  /summary              the document the four pages read (settings.egress / channels / version / outlet)
GET  /outlet               current outlet node and latency (a reading; failure is just a missing reading)
GET  /egress/url           the subscription URL itself — read only when the page asks to show/copy it
POST /settings             accepts the egress section only
GET  /chan-gateway         relay and gateway state (never the keys)
POST /chan-gateway/apply   change bind address/port
GET  /chan-gateway/key     the relay key, on demand
POST /chan-gateway/rotate  rotate the relay key
```

The dashboard and the request log **do not** go through here: the pack owns the per-request ledger and
the browser half talks to it over the shell's `connection` RPC (`usage.tokenLedger` /
`usage.tokenLedgerHistory`).

## Security

- **Credentials**: account tokens live in the pack's own credential store (`~/.dsh/.credentials.yaml`, 0600); the page never sees plaintext. The subscription URL is treated as a credential and read only when you ask to display it — ordinary payloads carry a masked host.
- **The LAN relay is the only listener facing outward**: off by default; when on it requires its own relay key (not shared with the local gateway key). **Anyone who can reach this machine can spend your channel quota** — enable it only on a trusted network, and firewall the source range if in doubt.
- **Trust fence**: the plugin's routes outrank the kernel's `/api`, so it carries the same admission check as the kernel — it reuses the composition's `connection` service when present, and otherwise falls back to a structural fence (loopback `Host`, no cross-site marker, same-origin `Origin`/`Referer`).
- **Egress audit**: see [`SECURITY-AUDIT.md`](https://github.com/YpipaQ/dsh-free-model/blob/slim-channels-only/SECURITY-AUDIT.md) — the verdict is **direct to each provider, no third-party relay, no telemetry**; it lists the thirteen providers' hosts with their TLS certificate subjects, the two non-vendor calls that carry no credentials, the local surface and the known risks. Re-run it with `node scripts/egress-audit.mjs --tls` (read-only; `--json` for machine output).

## Tests

```bash
npm test                            # 8 offline suites: no network, no quota
node scripts/host-smoke-test.mjs     # the host HTTP surface only
node scripts/client-lint.mjs         # the browser half only (dictionary keys, CSS reachability)
```

| Suite | Covers |
| --- | --- |
| `client-lint` | Browser half: registration, the two dictionaries agree key-for-key with no extras, every CSS rule is reachable, every emitted `ofm_*` class is defined |
| `client-render` | The four pages rendered for real against host-shaped payloads (catches references to deleted components) |
| `host-smoke` | The whole host HTTP surface: the four pages' data, outlet validation, relay key minting/rotation/persistence, **and that deleted routes 404** |
| `trust` / `chan-relay` / `egress` | Each host module's own contract |
| `channel-pack` / `channel-network` | Pack mounting, thirteen provider registrations, credits, image pricing, proxy and OAuth lifecycles |

The other 37 of upstream's 45 suites tested lanes this fork deletes. The suites run **from a checkout
only** — the npm package does not ship `scripts/`.

## The channel pack

`vendor/channel-pack/` is a complete sub-project (its own `package.json`, TypeScript sources, tests and
build script); `pack.js` is its bundle:

```bash
npm run channel-pack      # rebuild from vendor/channel-pack/src (needs esbuild)
```

Provenance, licence and what was changed are in `vendor/channel-pack/NOTICE.md`; OpenCode account
access is switched off when the pack mounts.

## License

This repository is MIT (see [`LICENSE`](https://github.com/YpipaQ/dsh-free-model/blob/slim-channels-only/LICENSE));
the vendored channel pack is covered by `vendor/channel-pack/LICENSE` and `NOTICE.md`. All channel
accounts, quotas and credit rules belong to their providers — follow their terms of service.
