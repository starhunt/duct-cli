[English](README.md) | **한국어**

# Duct-CLI

Codex CLI 기반 이미지 생성 어댑터 for [Star-CLIProxy](https://github.com/starhunt/star-cliproxy).

Codex CLI의 **builtin `image_gen` 2.0 (gpt-image 2.0)** 도구를 단일 바이너리로
감싸서, 한 번의 `duct image "..."` 호출로 이미지 생성을 수행하고 OpenAI
Images API 호환 응답을 돌려줍니다. Star-CLIProxy 본체 코드 수정 없이
`plugins/cliproxy-plugin-duct`로 등록되어 `/v1/images/generations` 엔드포인트에
자연스럽게 노출됩니다.

> 인증은 **ChatGPT 계정의 `codex login`**을 그대로 재사용합니다 —
> 별도의 `OPENAI_API_KEY` 불필요. ChatGPT Pro/Plus 구독자는 추가 과금 없이
> gpt-image 2.0 이미지 생성을 API처럼 쓸 수 있습니다.

## 상태

- ✅ MVP — `duct image "..."` / `duct openai:images --in --out` 두 모드 동작
- ✅ Bun single-file binary (`bun build --compile`) — 런타임 의존성 제로
- ✅ 한글 인포그래픽/포스터 프롬프트 검증 완료
- ✅ Star-CLIProxy 플러그인 통합 (`provider: duct`, alias `duct-image` / `gpt-image-2`)
- ✅ codex 기본 모델(`gpt-5.4`)이 `image_gen` 도구를 호출하는 경로 사용 —
  ChatGPT 계정에서 `gpt-image-1` 같은 전용 모델명 거부 이슈 우회

## 동작 원리

```
호출자
  ↓ duct image "프롬프트"
duct-cli
  ↓ spawn: codex exec --json --skip-git-repo-check \
  ↓        --dangerously-bypass-approvals-and-sandbox "<wrapped prompt>"
codex CLI ─── builtin image_gen 2.0 도구 호출
  ↓
~/.codex/generated_images/{thread_id}/ig_*.png  (codex가 저장)
  ↑ duct-cli가 디렉토리 폴링으로 감지
duct-cli
  ↓ OpenAI Images API 호환 응답 (file:// url 또는 b64_json)
```

- codex는 자신의 thread_id 디렉토리 하위에 생성된 이미지를 비동기로 떨어뜨림
- duct-cli는 `thread.started` 이벤트에서 thread_id를 얻고 그 디렉토리를
  1초 간격 폴링, `turn.completed` + grace period(5s)로 종료
- codex 프로세스는 항상 `stdio: ['ignore', 'pipe', 'pipe']`로 띄워 stdin
  읽기 루프(`Reading additional input from stdin…`)에 멈추지 않도록 함

## 빠른 시작 (로컬)

```bash
# 1. 의존성 설치 (Bun 1.2+ 필수)
bun install

# 2. codex CLI 설치 + 로그인
# npm i -g @openai/codex  (또는 brew install codex)
codex login

# 3. 직접 실행
bun run start image "한글 인포그래픽: AI 시대의 일하는 방식"

# 4. 빌드 (macOS 단일 바이너리)
bun run build
./dist/duct-macos image "귀여운 오리 캐릭터 일러스트"

# 5. 타입체크
bun run typecheck
```

## 영구 설치 (`~/.duct-cli/`)

Star-CLIProxy 등 외부 도구가 안정적인 경로로 호출할 수 있도록 전용
바이너리를 홈 디렉토리에 배치합니다.

```bash
mkdir -p ~/.duct-cli
bun build ./src/cli.ts --compile --outfile ~/.duct-cli/duct-cli

# 헬스 체크
~/.duct-cli/duct-cli --help   # 도움말 출력되면 OK

# 스모크 테스트 (실제 codex 호출)
~/.duct-cli/duct-cli image "a minimalist duct logo" -v
```

> Bun `--compile`은 Bun 런타임 + 스크립트를 하나로 묶은 native binary를
> 만듭니다. 빌드 머신과 다른 OS/arch에는 재빌드 필요.

## Star-CLIProxy 플러그인 등록

1. 플러그인 코드 배치 — Star-CLIProxy 레포의
   `plugins/cliproxy-plugin-duct/index.js` (이 레포의 참조본과 동일)
2. `config.yaml`에 등록:

   ```yaml
   plugins:
     - path: "./plugins/cliproxy-plugin-duct"
       config:
         cli_path: "/Users/<user>/.duct-cli/duct-cli"
         default_model: ""            # 비워두면 codex 기본(gpt-5.4) 사용 — 권장
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

3. `./start.sh restart` → 로그에 `Plugin loaded: "duct" (endpoints: images)` 확인
4. OpenAI 호환 호출:

   ```bash
   curl -s http://localhost:8300/v1/images/generations \
     -H "Authorization: Bearer $PROXY_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{
       "model": "duct-image",
       "prompt": "한글 인포그래픽: 전기차 충전 인프라 현황",
       "response_format": "url"
     }'
   ```

## CLI 명령

### `duct image "<프롬프트>"`

인라인 프롬프트 → codex 호출 → 이미지 경로 포함 JSON 결과를 stdout으로.

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
  "agentMessage": "이미지를 생성했습니다."
}
```

### `duct openai:images --in req.json --out res.json`

Star-CLIProxy 플러그인이 사용하는 파일 기반 인터페이스. stdout 노이즈 없이
파일로만 I/O해 대용량 응답에 안전.

**요청 (`req.json`)**

```json
{
  "model": "gpt-5.4",
  "prompt": "a stylised polar bear logo",
  "response_format": "url"
}
```

**응답 (`res.json`)** — OpenAI Images API 호환

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

`response_format: "b64_json"`을 보내면 `data[].b64_json`에 base64 payload가
실립니다 (같은 호스트 호출자는 `url` 모드가 압도적으로 저렴).

## 응답 모드: 기본 `url`, b64 옵트인

| 모드 | 트리거 | 응답 크기 (1024² PNG 기준) | 용도 |
|------|--------|---------------------------|------|
| `url` (기본) | 미지정 또는 `"url"` | 수백 B | LLM 에이전트, 동일 호스트 소비자 |
| `b64_json` | `response_format: "b64_json"` | ~700 KB+ | 웹 프론트엔드, 원격 호출자 |

같은 호스트 호출자는 `file://` 경로를 fs로 직접 읽어 base64와 동일한
결과를 얻을 수 있습니다 (네트워크 ~2MB/장 절약):

```ts
const item = res.data[0];
const bytes = item.b64_json
  ? Buffer.from(item.b64_json, "base64")
  : await Bun.file(item.url.replace(/^file:\/\//, "")).bytes();
```

## 옵션

```
duct image "프롬프트"             이미지 생성
duct "프롬프트"                   이미지 생성 (image 키워드 생략 가능)
duct openai:images --in req.json --out res.json

  -m, --model <model>       codex 모델 지정 (기본: codex 설정값 gpt-5.4)
  -t, --timeout-ms <ms>     타임아웃 (기본 300000)
  -b, --bin <path>          codex 바이너리 경로 override
  -v, --verbose             stderr에 [duct] 이벤트/폴링 로그
      --in <file>           OpenAI 호환 입력 JSON 파일
      --out <file>          OpenAI 호환 출력 JSON 파일
  -h, --help                도움말
```

## 환경변수

| 변수 | 필수 | 기본값 | 설명 |
|------|------|--------|------|
| `CODEX_BIN` | ⬜ | `codex` | codex 바이너리 경로 override |
| `CODEX_HOME` | ⬜ | `~/.codex` | codex 홈 (생성 이미지가 `generated_images/{thread_id}/`에 저장) |
| `DUCT_CLI_BIN` | ⬜ | `~/.duct-cli/duct-cli` | 플러그인 쪽에서 duct 바이너리 경로 override |

codex 바이너리 탐색 순서: `CODEX_BIN` → `$PATH`의 `codex` →
`~/.npm-global/bin/codex` → `~/.bun/bin/codex` → `/usr/local/bin/codex` →
`/opt/homebrew/bin/codex`.

## 모델

| 모델 | 비고 |
|------|------|
| `gpt-5.4` *(권장)* | codex 기본. `image_gen` 도구를 자동 호출. ChatGPT 계정 그대로 사용 |
| `gpt-image-2` | alias. 플러그인 가드가 자동으로 `--model` 인자를 떨궈 codex 기본으로 폴백 |
| `dall-e-*` / `imagen-*` / `flux*` 등 | 플러그인이 자동 필터링 (codex의 ChatGPT 경로는 수용 안 함) |

> `gpt-image-1`, `dall-e-3` 등 OpenAI 플랫폼 전용 이미지 모델명을 그대로
> `codex --model`로 넘기면 거부당합니다. Star-CLIProxy 플러그인의
> `isCodexCompatibleModel()` 가드가 이런 이름을 감지하면 `--model`을
> 생략하고 codex 기본 설정이 `image_gen` 도구를 호출하도록 유도합니다.

## 개발

```bash
# 타입체크 (tsc --noEmit)
bun run typecheck

# 로컬 실행
bun run start image "테스트 프롬프트" --verbose

# 프로덕션 빌드 (macOS native binary, ~57MB)
bun run build
```

TypeScript strict mode, ESM, Bun APIs (`Bun.file`, `Bun.spawnSync`) 혼용.

## 레이아웃

```
src/
  cli.ts      # 전체 구현 — argparse, codex spawn, 디렉토리 폴링,
              #   thread_id → images, OpenAI 호환 응답 변환

dist/
  duct-macos  # bun build --compile 산출물 (gitignored, Releases 권장)

package.json  # bin: { duct: ./src/cli.ts }, build 스크립트
```

> 단일 파일 구성 — 복잡한 모듈 분할보다 `cli.ts` 안의 섹션 주석으로
> 네비게이션. 이벤트 타입 / 유틸 / 폴링 / OpenAI 어댑터 / argparse / main.

## 제약 / 주의

- **디렉토리 폴링 기반 종료**: codex가 `turn.completed` 이후에도 이미지를
  비동기로 떨어뜨릴 수 있어 5초 grace period 필요. 타이밍 레이스가 의심되면
  `-v` 로 `[duct] 폴링: 이미지 N개 + turn 완료 → finalize` 로그 확인.
- **ChatGPT 로그인 만료**: `codex login` 세션이 끊기면 duct도 실패.
  `codex --version` 또는 `codex exec --json "ping"` 으로 주기 점검.
- **stdin 이슈 방지**: duct-cli는 항상 `stdio: ['ignore', ...]`로 codex를
  띄웁니다. 과거 codex의 `Reading additional input from stdin…` 대기로
  멈추는 이슈 예방.
- **동시성**: 기본 `max_concurrent: 1` — codex가 한 계정당 세션/레이트
  제한을 걸기 때문. 병렬이 필요하면 플러그인 쪽에서 큐잉.

## 운영 메모

- **배포**: `bun run build`로 만든 `dist/duct-macos`를 `~/.duct-cli/duct-cli`
  에 복사. GitHub Releases에 업로드 권장 (repo에는 `.gitignore`로 제외).
- **비밀**: `~/.codex/auth.json`에 ChatGPT OAuth 토큰이 들어있음. 절대
  커밋/공유 금지. duct-cli는 이 파일을 직접 읽지 않고 codex를 통해서만
  접근 — stdout/결과 JSON에 토큰이 흘러가지 않도록 설계.
- **이미지 캐시**: `~/.codex/generated_images/{thread_id}/` — 주기적으로
  정리하지 않으면 계속 쌓임. 호출자 쪽에서 소비 후 삭제를 권장.

## 라이선스

MIT — [LICENSE](LICENSE)
