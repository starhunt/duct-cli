**English** | [한국어](README.ko.md)

# Duct-CLI

A Codex CLI-based image generation adapter for [Star-CLIProxy](https://github.com/starhunt/star-cliproxy).

Duct-CLI wraps Codex CLI's **builtin `image_gen` 2.0 (gpt-image 2.0)** tool in a
single binary. One `duct image "..."` call performs image generation and returns
an OpenAI Images API-compatible response. With no changes to Star-CLIProxy's core,
it registers as `plugins/cliproxy-plugin-duct` and exposes itself naturally on the
`/v1/images/generations` endpoint.

> Authentication reuses your **ChatGPT account's `codex login`** as-is — no
> separate `OPENAI_API_KEY` required. ChatGPT Pro/Plus subscribers can use
> gpt-image 2.0 generation like an API at no extra cost.

## Status

- ✅ MVP — both `duct image "..."` and `duct openai:images --in --out` modes work
- ✅ Bun single-file binary (`bun build --compile`) — zero runtime dependencies
- ✅ Validated with Korean infographic/poster prompts
- ✅ Star-CLIProxy plugin integration (`provider: duct`, alias `duct-image` / `gpt-image-2`)
- ✅ Uses the path where codex's default model (`gpt-5.4`) invokes the `image_gen`
  tool — sidesteps the issue of ChatGPT accounts rejecting dedicated model names
  like `gpt-image-1`

## How it works

```
caller
  ↓ duct image "prompt"
duct-cli
  ↓ spawn: codex exec --json --skip-git-repo-check \
  ↓        --dangerously-bypass-approvals-and-sandbox "<wrapped prompt>"
codex CLI ─── invokes builtin image_gen 2.0 tool
  ↓
~/.codex/generated_images/{thread_id}/ig_*.png  (saved by codex)
  ↑ duct-cli detects it via directory polling
duct-cli
  ↓ OpenAI Images API-compatible response (file:// url or b64_json)
```

- codex asynchronously drops generated images under its own thread_id directory
- duct-cli obtains the thread_id from the `thread.started` event, polls that
  directory at 1-second intervals, and finalizes on `turn.completed` + a grace
  period (5s)
- The codex process is always launched with `stdio: ['ignore', 'pipe', 'pipe']`
  so it never stalls on a stdin read loop (`Reading additional input from stdin…`)

## Quick start (local)

```bash
# 1. Install dependencies (requires Bun 1.2+)
bun install

# 2. Install + log in to the codex CLI
# npm i -g @openai/codex  (or brew install codex)
codex login

# 3. Run directly
bun run start image "Korean infographic: ways of working in the AI era"

# 4. Build (macOS single binary)
bun run build
./dist/duct-macos image "cute duck character illustration"

# 5. Typecheck
bun run typecheck
```

## Permanent install (`~/.duct-cli/`)

Place a dedicated binary in the home directory so external tools like
Star-CLIProxy can call it via a stable path.

```bash
mkdir -p ~/.duct-cli
bun build ./src/cli.ts --compile --outfile ~/.duct-cli/duct-cli

# Health check
~/.duct-cli/duct-cli --help   # OK if help text prints

# Smoke test (real codex call)
~/.duct-cli/duct-cli image "a minimalist duct logo" -v
```

> Bun `--compile` produces a native binary bundling the Bun runtime + the script.
> A rebuild is required for an OS/arch different from the build machine.

## Star-CLIProxy plugin registration

1. Place the plugin code — Star-CLIProxy repo's
   `plugins/cliproxy-plugin-duct/index.js` (identical to the reference copy in this repo)
2. Register in `config.yaml`:

   ```yaml
   plugins:
     - path: "./plugins/cliproxy-plugin-duct"
       config:
         cli_path: "/Users/<user>/.duct-cli/duct-cli"
         default_model: ""            # leave empty to use codex default (gpt-5.4) — recommended
         max_concurrent: 1
         timeout_ms: 300000

   model_mappings:
     - alias: "duct-image"
       provider: "duct"
       actual_model: "gpt-5.4"
     - alias: "gpt-image-2"
       provider: "duct"
       actual_model: "gpt-image-2"
   ```

3. `./start.sh restart` → confirm `Plugin loaded: "duct" (endpoints: images)` in the logs
4. OpenAI-compatible call:

   ```bash
   curl -s http://localhost:8300/v1/images/generations \
     -H "Authorization: Bearer $PROXY_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{
       "model": "duct-image",
       "prompt": "Korean infographic: EV charging infrastructure status",
       "response_format": "url"
     }'
   ```

## CLI commands

### `duct image "<prompt>"`

Inline prompt → codex call → JSON result with image paths to stdout.

```json
{
  "success": true,
  "threadId": "abc123…",
  "images": [
    {
      "path": "~/.codex/generated_images/abc123/ig_xyz.png",
      "mimeType": "image/png",
      "callId": "ig_xyz"
    }
  ],
  "agentMessage": "Image generated."
}
```

### `duct openai:images --in req.json --out res.json`

The file-based interface used by the Star-CLIProxy plugin. It does I/O purely
through files with no stdout noise, making it safe for large responses.

**Request (`req.json`)**

```json
{
  "model": "gpt-5.4",
  "prompt": "a stylised polar bear logo",
  "response_format": "url"
}
```

**Response (`res.json`)** — OpenAI Images API-compatible

```json
{
  "created": 1744272000,
  "model": "gpt-5.4",
  "data": [
    { "url": "/Users/.../ig_xyz.png" }
  ],
  "_meta": {
    "thread_id": "abc123…",
    "paths": ["/Users/.../ig_xyz.png"],
    "agent_message": "…"
  }
}
```

Sending `response_format: "b64_json"` puts the base64 payload in `data[].b64_json`
(for same-host callers, `url` mode is overwhelmingly cheaper).

## Response modes: `url` by default, b64 opt-in

| Mode | Trigger | Response size (1024² PNG) | Use case |
|------|---------|---------------------------|----------|
| `url` (default) | unspecified or `"url"` | a few hundred B | LLM agents, same-host consumers |
| `b64_json` | `response_format: "b64_json"` | ~700 KB+ | web frontends, remote callers |

A same-host caller can read the `file://` path directly via fs to get the same
result as base64 (saving ~2MB/image of network):

```ts
const item = res.data[0];
const bytes = item.b64_json
  ? Buffer.from(item.b64_json, "base64")
  : await Bun.file(item.url.replace(/^file:\/\//, "")).bytes();
```

## Options

```
duct image "prompt"               generate an image
duct "prompt"                     generate an image (the "image" keyword may be omitted)
duct openai:images --in req.json --out res.json

  -m, --model <model>       specify codex model (default: codex config value gpt-5.4)
  -t, --timeout-ms <ms>     timeout (default 300000)
  -b, --bin <path>          override codex binary path
  -v, --verbose             [duct] event/polling logs to stderr
      --in <file>           OpenAI-compatible input JSON file
      --out <file>          OpenAI-compatible output JSON file
  -h, --help                help
```

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CODEX_BIN` | ⬜ | `codex` | override codex binary path |
| `CODEX_HOME` | ⬜ | `~/.codex` | codex home (generated images saved under `generated_images/{thread_id}/`) |
| `DUCT_CLI_BIN` | ⬜ | `~/.duct-cli/duct-cli` | override duct binary path from the plugin side |

codex binary lookup order: `CODEX_BIN` → `codex` on `$PATH` →
`~/.npm-global/bin/codex` → `~/.bun/bin/codex` → `/usr/local/bin/codex` →
`/opt/homebrew/bin/codex`.

## Models

| Model | Notes |
|-------|-------|
| `gpt-5.4` *(recommended)* | codex default. Auto-invokes the `image_gen` tool. Uses the ChatGPT account as-is |
| `gpt-image-2` | alias. The plugin guard automatically drops the `--model` arg and falls back to the codex default |
| `dall-e-*` / `imagen-*` / `flux*`, etc. | auto-filtered by the plugin (codex's ChatGPT path doesn't accept them) |

> Passing OpenAI platform-only image model names like `gpt-image-1` or `dall-e-3`
> directly to `codex --model` gets rejected. When the Star-CLIProxy plugin's
> `isCodexCompatibleModel()` guard detects such names, it omits `--model` and lets
> the codex default config invoke the `image_gen` tool.

## Development

```bash
# Typecheck (tsc --noEmit)
bun run typecheck

# Run locally
bun run start image "test prompt" --verbose

# Production build (macOS native binary, ~57MB)
bun run build
```

TypeScript strict mode, ESM, with a mix of Bun APIs (`Bun.file`, `Bun.spawnSync`).

## Layout

```
src/
  cli.ts      # full implementation — argparse, codex spawn, directory polling,
              #   thread_id → images, OpenAI-compatible response conversion

dist/
  duct-macos  # bun build --compile output (gitignored, prefer Releases)

package.json  # bin: { duct: ./src/cli.ts }, build scripts
```

> Single-file layout — rather than complex module splitting, navigate via section
> comments inside `cli.ts`: event types / utils / polling / OpenAI adapter /
> argparse / main.

## Constraints / caveats

- **Directory-polling-based termination**: codex may asynchronously drop images
  even after `turn.completed`, so a 5-second grace period is needed. If you
  suspect a timing race, check the `[duct] polling: N images + turn complete →
  finalize` log with `-v`.
- **ChatGPT login expiry**: if the `codex login` session drops, duct fails too.
  Periodically check with `codex --version` or `codex exec --json "ping"`.
- **stdin issue prevention**: duct-cli always launches codex with
  `stdio: ['ignore', ...]`, preventing the past issue of stalling on codex's
  `Reading additional input from stdin…` wait.
- **Concurrency**: default `max_concurrent: 1` — because codex enforces
  session/rate limits per account. If you need parallelism, queue on the plugin side.

## Operational notes

- **Deploy**: copy the `dist/duct-macos` built by `bun run build` to
  `~/.duct-cli/duct-cli`. Uploading to GitHub Releases is recommended (excluded
  from the repo via `.gitignore`).
- **Secrets**: `~/.codex/auth.json` contains the ChatGPT OAuth token. Never
  commit/share it. duct-cli does not read this file directly — it accesses it
  only through codex, and is designed so the token never leaks into stdout/result JSON.
- **Image cache**: `~/.codex/generated_images/{thread_id}/` — keeps accumulating
  unless cleaned periodically. Callers are advised to delete after consuming.

## License

MIT — [LICENSE](LICENSE)
