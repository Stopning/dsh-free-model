# Model Access (Our Free Model) — channels-only fork

> **A DSH plugin** (DeepSeek Harness · cordis bundle, `dsh-plugin`) —
> a trimmed fork of [`Ebony-Vinyl/dsh-our-free-model`](https://github.com/Ebony-Vinyl/dsh-our-free-model) **2.1.0**.
> One lane survives: **bring your own account channels** — thirteen providers, plus a token
> dashboard, a per-request log and a local gateway. Upstream's anonymous free lane, the EAC
> co-paid lane, the aggregate lane, the token savers, the routing chains and the whole
> release/update channel are gone.
> The settings entry reads **模型接入** in Chinese, **Model Access** in English; the npm package is
> `dsh-free-model` (same as the repository), while the cordis loader entry id stays `our-free-model`
> — the settings namespace and the state directory hang off that id, so renaming the package moves no data.

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

Sizes: `src/` went from **58 modules to 5**, the host `index.js` from **2343 to 684 lines**,
and the offline suites from 45 to 7.

## Install

```bash
dsh plugin --profile web add dsh-free-model            # from npm
dsh plugin --profile web add /absolute/path/dsh-free-model   # or from a checkout
```

Restart the app once. On the desktop build, do **not** use `link:` dependencies or junctions
(the profile gate rejects them); copy a real directory into
`<profile>/node_modules/dsh-free-model/`, add `"dsh-free-model": "2.1.0"` to
`dependencies`, and append `"dsh-free-model"` to `dsh.profile.bundles`.
The loader entry id stays `our-free-model` (`id:` in `cordis.patch.yml`), so the settings
namespace and the state directory `~/.dsh/our-free-model/` are unaffected by the package name.

Note that upstream's `adapter/` directory no longer exists in this fork.

## Configuration

The only state file is `~/.dsh/our-free-model/settings.json` (0600); this fork reads three
keys — `egress`, `chanGateway.relay` and `version`. Keys written by 2.1.0 are preserved but
inert, so an upgrade keeps your outlet address and relay key.

```bash
npm test                          # 7 offline suites: no network, no quota
node scripts/host-smoke-test.mjs  # the host HTTP surface only
node scripts/client-lint.mjs      # the browser half only
```

## License

MIT (`LICENSE`); the vendored channel pack is covered by `vendor/channel-pack/LICENSE` and
`NOTICE.md`. All channel accounts, quotas and credit rules belong to their providers.
