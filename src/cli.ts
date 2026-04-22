#!/usr/bin/env bun

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

// ---------------------------------------------------------------------------
// 상수
// ---------------------------------------------------------------------------
const APP_NAME = "duct-cli";
const DEFAULT_TIMEOUT_MS = 300_000; // 5분

// codex 이미지 아티팩트 저장 위치
const CODEX_HOME = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
const GENERATED_IMAGES_DIR = path.join(CODEX_HOME, "generated_images");

// codex 바이너리 경로 탐색 순서
const CODEX_BIN_CANDIDATES = [
  process.env.CODEX_BIN,
  "codex",
  path.join(os.homedir(), ".npm-global/bin/codex"),
  path.join(os.homedir(), ".bun/bin/codex"),
  "/usr/local/bin/codex",
  "/opt/homebrew/bin/codex",
].filter(Boolean) as string[];

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

// ---------------------------------------------------------------------------
// codex --json 이벤트 타입
// ---------------------------------------------------------------------------

interface ThreadStartedEvent {
  type: "thread.started";
  thread_id: string;
}

interface TurnStartedEvent {
  type: "turn.started";
}

interface ItemCompletedEvent {
  type: "item.completed";
  item: {
    id: string;
    type: string;
    text?: string;
    [k: string]: unknown;
  };
}

interface TurnCompletedEvent {
  type: "turn.completed";
  usage?: Record<string, number>;
}

interface ErrorEvent {
  type: "error";
  message?: string;
}

type CodexEvent =
  | ThreadStartedEvent
  | TurnStartedEvent
  | ItemCompletedEvent
  | TurnCompletedEvent
  | ErrorEvent
  | { type: string; [k: string]: unknown };

interface ImageResult {
  success: boolean;
  threadId?: string;
  images: Array<{
    path?: string;
    mimeType?: string;
    callId?: string;
  }>;
  error?: string;
  agentMessage?: string;
}

// ---------------------------------------------------------------------------
// 유틸리티
// ---------------------------------------------------------------------------

function resolveCodexBin(explicit?: string): string {
  if (explicit) return explicit;
  for (const candidate of CODEX_BIN_CANDIDATES) {
    try {
      const result = Bun.spawnSync(["which", candidate]);
      if (result.exitCode === 0) return candidate;
    } catch {
      // 다음 후보
    }
  }
  return "codex";
}

function guessMimeType(s: string): string {
  if (/\.png/i.test(s)) return "image/png";
  if (/\.jpe?g/i.test(s)) return "image/jpeg";
  if (/\.gif/i.test(s)) return "image/gif";
  if (/\.webp/i.test(s)) return "image/webp";
  return "image/png";
}

// ---------------------------------------------------------------------------
// generated_images/{thread_id}/ 디렉토리에서 이미지 파일 검색
// ---------------------------------------------------------------------------

/**
 * threadId에 해당하는 generated_images 디렉토리에서 이미지 파일들을 찾는다.
 * codex는 생성한 이미지를 ~/.codex/generated_images/{thread_id}/ig_{call_id}.png 형태로 저장한다.
 */
async function findGeneratedImages(
  threadId: string
): Promise<Array<{ filePath: string; callId?: string; mimeType: string }>> {
  const dirPath = path.join(GENERATED_IMAGES_DIR, threadId);
  const results: Array<{ filePath: string; callId?: string; mimeType: string }> = [];

  try {
    const entries = await fs.readdir(dirPath);
    const imageFiles = entries.filter((e) => {
      if (e.startsWith(".")) return false;
      const ext = path.extname(e).toLowerCase();
      return IMAGE_EXTENSIONS.has(ext);
    });

    for (const file of imageFiles) {
      const filePath = path.join(dirPath, file);
      // ig_{call_id}.png 패턴에서 call_id 추출
      const match = file.match(/^(ig_[a-z0-9]+)\.[a-z]+$/i);
      results.push({
        filePath,
        callId: match?.[1],
        mimeType: guessMimeType(file),
      });
    }
  } catch {
    // 디렉토리 없음 — 정상
  }

  return results;
}

// ---------------------------------------------------------------------------
// codex exec --json 실행
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 1_000; // 디렉토리 폴링 주기
const POST_TURN_GRACE_MS = 5_000; // turn.completed 후 이미지 도착 대기 (안전장치)

async function runCodexImage(opts: {
  bin: string;
  model?: string;
  prompt: string;
  timeoutMs: number;
  verbose: boolean;
}): Promise<ImageResult> {
  // codex가 image_gen 빌트인 도구를 호출하도록 명시적으로 유도
  const wrappedPrompt = opts.prompt.includes("image_gen")
    ? opts.prompt
    : `다음 요구를 image_gen 빌트인 도구를 사용해 이미지로 생성해줘. 텍스트 응답이나 추가 설명 없이 이미지 생성만 수행할 것.\n\n요청: ${opts.prompt}`;

  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
  ];
  if (opts.model) {
    args.push("--model", opts.model);
  }
  args.push(wrappedPrompt);

  if (opts.verbose) {
    console.error(`[duct] 실행: ${opts.bin} exec --json ... <prompt>`);
  }

  return new Promise<ImageResult>((resolve) => {
    const proc = spawn(opts.bin, args, {
      // stdin은 ignore — codex가 "Reading additional input from stdin..."에서 멈추지 않도록
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let threadId: string | undefined;
    let agentMessage = "";
    let errorMsg: string | undefined;
    let resolved = false;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let turnCompleted = false;
    let turnCompletedAt = 0;

    async function finalize(): Promise<void> {
      if (resolved) return;
      resolved = true;
      if (pollTimer) clearInterval(pollTimer);

      const images: ImageResult["images"] = [];
      if (threadId) {
        const found = await findGeneratedImages(threadId);
        for (const img of found) {
          images.push({
            path: img.filePath,
            mimeType: img.mimeType,
            callId: img.callId,
          });
        }
        if (opts.verbose) {
          console.error(`[duct] generated_images/${threadId}/ 에서 ${images.length}개 발견`);
        }
      }

      // codex 프로세스가 살아있으면 정리
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      try {
        proc.kill();
      } catch {
        // ignore
      }

      resolve({
        success: images.length > 0,
        threadId,
        images,
        agentMessage: agentMessage || undefined,
        error:
          images.length === 0
            ? errorMsg ??
              "이미지를 찾을 수 없습니다. codex가 image_gen 도구를 호출하지 못했을 수 있습니다."
            : undefined,
      });
    }

    function startPolling(): void {
      if (pollTimer || !threadId) return;
      if (opts.verbose) {
        console.error(`[duct] 디렉토리 폴링 시작 (thread=${threadId})`);
      }
      pollTimer = setInterval(async () => {
        if (resolved) {
          if (pollTimer) clearInterval(pollTimer);
          return;
        }
        const images = await findGeneratedImages(threadId!);
        if (images.length > 0) {
          // 이미지 발견 + turn.completed 도 끝났으면 즉시 종료
          // turn 진행 중이면 다음 이미지가 더 생길 수 있으므로 기다림
          if (turnCompleted) {
            if (opts.verbose) {
              console.error(`[duct] 폴링: 이미지 ${images.length}개 + turn 완료 → finalize`);
            }
            await finalize();
            return;
          }
        }
        // turn.completed 후 grace period 경과 시 강제 종료 (이미지 유무 무관)
        if (turnCompleted && Date.now() - turnCompletedAt > POST_TURN_GRACE_MS) {
          if (opts.verbose) {
            console.error(`[duct] turn 완료 후 grace period 경과 → finalize`);
          }
          await finalize();
        }
      }, POLL_INTERVAL_MS);
    }

    const rl = createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      if (!line.trim() || resolved) return;
      try {
        const event = JSON.parse(line) as CodexEvent;

        if (event.type === "thread.started" && "thread_id" in event) {
          threadId = (event as ThreadStartedEvent).thread_id;
          if (opts.verbose) {
            console.error(`[duct] 스레드 시작: ${threadId}`);
          }
          startPolling();
          return;
        }

        if (event.type === "item.completed" && "item" in event) {
          const item = (event as ItemCompletedEvent).item;
          if (item.type === "agent_message" && typeof item.text === "string") {
            agentMessage += item.text;
          }
          return;
        }

        if (event.type === "turn.completed") {
          turnCompleted = true;
          turnCompletedAt = Date.now();
          if (opts.verbose) {
            console.error(`[duct] turn.completed`);
          }
          return;
        }

        if (event.type === "error") {
          const msg = (event as ErrorEvent).message;
          if (msg) errorMsg = msg;
          if (opts.verbose) {
            console.error(`[duct] error 이벤트: ${msg}`);
          }
        }
      } catch {
        if (opts.verbose) {
          console.error(`[duct] JSON 파싱 실패: ${line.slice(0, 120)}`);
        }
      }
    });

    const stderrChunks: string[] = [];
    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrChunks.push(text);
      if (opts.verbose) {
        process.stderr.write(text);
      }
    });

    proc.on("close", async (code) => {
      if (code !== 0 && !errorMsg) {
        errorMsg = stderrChunks.join("").trim() || `codex 종료 코드: ${code}`;
      }
      // 프로세스가 끝났는데 아직 이미지를 못 찾았어도, 한 번 더 디렉토리 확인 후 종료
      if (!resolved) {
        // 이미지 도착 직후 close가 올 수 있으므로 잠시 대기
        setTimeout(finalize, 500);
      }
    });

    // 전체 타임아웃 (안전장치)
    setTimeout(() => {
      if (!resolved) {
        errorMsg = `타임아웃: ${opts.timeoutMs}ms 내에 이미지를 받지 못했습니다.`;
        finalize();
      }
    }, opts.timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// OpenAI 호환 이미지 인터페이스 (Star-cliProxy용)
// ---------------------------------------------------------------------------

interface OpenAIImageRequest {
  model?: string;
  prompt: string;
  size?: string;
  response_format?: "url" | "b64_json";
  n?: number;
}

interface OpenAIImageResponse {
  created: number;
  model: string;
  data: Array<{
    url?: string;
    b64_json?: string;
  }>;
  _meta?: {
    thread_id?: string;
    paths?: string[];
    agent_message?: string;
  };
}

async function handleOpenAIImages(opts: {
  inFile: string;
  outFile: string;
  bin: string;
  timeoutMs: number;
  verbose: boolean;
}): Promise<void> {
  const input: OpenAIImageRequest = JSON.parse(await fs.readFile(opts.inFile, "utf-8"));

  const result = await runCodexImage({
    bin: opts.bin,
    model: input.model,
    prompt: input.prompt,
    timeoutMs: opts.timeoutMs,
    verbose: opts.verbose,
  });

  if (!result.success) {
    const errResponse = {
      error: {
        message: result.error ?? "이미지 생성 실패",
        type: "generation_error",
        code: "image_generation_failed",
      },
    };
    await fs.writeFile(opts.outFile, JSON.stringify(errResponse, null, 2), "utf-8");
    process.exit(1);
  }

  const response: OpenAIImageResponse = {
    created: Math.floor(Date.now() / 1000),
    model: input.model ?? "codex",
    data: await Promise.all(
      result.images.map(async (img) => {
        const imagePath = img.path;
        if (input.response_format === "b64_json" && imagePath) {
          try {
            const file = Bun.file(imagePath);
            const buf = Buffer.from(await file.arrayBuffer());
            return { b64_json: buf.toString("base64") };
          } catch {
            return { url: imagePath };
          }
        }
        return { url: imagePath };
      })
    ),
    _meta: {
      thread_id: result.threadId,
      paths: result.images.map((i) => i.path).filter(Boolean) as string[],
      agent_message: result.agentMessage,
    },
  };

  await fs.writeFile(opts.outFile, JSON.stringify(response, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// CLI 인자 파싱
// ---------------------------------------------------------------------------

interface CliArgs {
  command: string;
  prompt: string;
  model?: string;
  bin: string;
  timeoutMs: number;
  verbose: boolean;
  inFile?: string;
  outFile?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      flags["help"] = true;
    } else if (arg === "--verbose" || arg === "-v") {
      flags["verbose"] = true;
    } else if (arg.startsWith("--") && i + 1 < args.length && !args[i + 1].startsWith("--")) {
      const key = arg.replace(/^--/, "");
      flags[key] = args[++i];
    } else if (arg.startsWith("-") && arg.length === 2 && i + 1 < args.length) {
      const shortMap: Record<string, string> = {
        m: "model",
        t: "timeout-ms",
        b: "bin",
      };
      const key = shortMap[arg[1]] ?? arg[1];
      flags[key] = args[++i];
    } else {
      positional.push(arg);
    }
  }

  if (flags["help"]) {
    printHelp();
    process.exit(0);
  }

  const command = positional[0] ?? "image";
  const isKnownCommand = command === "image" || command === "openai:images" || command === "help";
  const prompt = isKnownCommand ? positional.slice(1).join(" ") : positional.join(" ");

  return {
    command: isKnownCommand ? command : "image",
    prompt,
    model: flags["model"] as string | undefined,
    bin: resolveCodexBin(flags["bin"] as string | undefined),
    timeoutMs: Number(flags["timeout-ms"]) || DEFAULT_TIMEOUT_MS,
    verbose: !!flags["verbose"],
    inFile: flags["in"] as string | undefined,
    outFile: flags["out"] as string | undefined,
  };
}

function printHelp(): void {
  console.log(`
${APP_NAME} — Codex CLI 기반 이미지 생성 도구 (Star-cliProxy 플러그인용)

사용법:
  duct image "프롬프트"             이미지 생성
  duct "프롬프트"                   이미지 생성 (image 생략 가능)
  duct openai:images --in req.json --out res.json
                                    OpenAI 호환 이미지 생성

옵션:
  -m, --model <model>       codex 모델 지정 (기본: codex 설정값)
  -t, --timeout-ms <ms>     타임아웃 (기본: 300000)
  -b, --bin <path>          codex 바이너리 경로
  -v, --verbose             상세 로그 출력
      --in <file>           OpenAI 호환 입력 JSON 파일
      --out <file>          OpenAI 호환 출력 JSON 파일
  -h, --help                도움말

예시:
  duct image "한글 인포그래픽: AI 시대의 일하는 방식"
  duct "귀여운 오리 캐릭터 일러스트"
  duct openai:images --in req.json --out res.json --verbose

이미지 위치:
  ~/.codex/generated_images/{thread_id}/ig_*.png 에 저장됩니다.
  (CODEX_HOME 환경변수가 설정되어 있으면 그 경로 하위)

환경 변수:
  CODEX_BIN       codex 바이너리 경로 오버라이드
  CODEX_HOME      codex 홈 디렉토리 (기본: ~/.codex)
`);
}

// ---------------------------------------------------------------------------
// 메인
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  switch (args.command) {
    case "image": {
      if (!args.prompt) {
        console.error("에러: 프롬프트를 입력해주세요.");
        console.error('사용법: duct image "이미지 설명"');
        process.exit(1);
      }

      const result = await runCodexImage({
        bin: args.bin,
        model: args.model,
        prompt: args.prompt,
        timeoutMs: args.timeoutMs,
        verbose: args.verbose,
      });

      console.log(JSON.stringify(result, null, 2));
      if (!result.success) process.exit(1);
      break;
    }

    case "openai:images": {
      if (!args.inFile || !args.outFile) {
        console.error("에러: --in 과 --out 파일 경로를 지정해주세요.");
        console.error("사용법: duct openai:images --in req.json --out res.json");
        process.exit(1);
      }

      await handleOpenAIImages({
        inFile: args.inFile,
        outFile: args.outFile,
        bin: args.bin,
        timeoutMs: args.timeoutMs,
        verbose: args.verbose,
      });
      break;
    }

    case "help":
    default:
      printHelp();
      break;
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[${APP_NAME}] 치명적 에러:`, (err as Error).message ?? err);
    process.exit(1);
  });
