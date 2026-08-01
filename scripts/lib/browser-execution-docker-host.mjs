/**
 * Docker 隔离执行宿主适配器：--network none 容器内的 loopback-only 执行。
 *
 * 与 browser-execution-host.mjs 同形，提供 dockerLifecycleAdapter、
 * dockerReadinessProbe、dockerRunner、dockerBrowserVersionProbe、
 * dockerTeardownInspector 与 dockerResourceObserver，供
 * createBrowserExecutionController 在 plan.isolation.executor === 'docker'
 * 时经 browser-extension-runner 注入。
 *
 * 机械边界：
 * - 只用 execFileSync/spawnSync('docker', ...) 参数数组，shell:false，无 shell string；
 * - daemon 不可用或镜像缺失在任何副作用前失败关闭（docker info /
 *   docker image inspect），禁止 docker pull；
 * - 容器一律 --network none：loopback 可用，非 loopback 目标内核层不可达；
 * - 挂载卫生（Attempt 004/005）：项目根以只读挂载（<root>:/work:ro），
 *   不挂载任何宿主可写 bind mount——M5 output root 不再出现在容器挂载
 *   命名空间，容器内输出写容器自身可写层 /e2e-output，执行成功（无
 *   errorCode）后 docker cp 拷贝回宿主 output root；OOM/timeout/异常
 *   路径维持 docker rm -f 清场不拷贝。宿主 output root 成功路径内容与
 *   既有 M5 外部语义一致；
 * - Unix socket 门：启动任何容器前 /usr/bin/find <root> -type s -print
 *   机械扫描，发现即失败关闭（RESOURCE_ISOLATION_UNSAFE，零副作用）。
 *   output root 不再挂载后扫描-挂载时间窗（TOCTOU）面消除；ro 挂载上
 *   AF_UNIX connect 在内核层被拒绝（Linux MAY_WRITE/EROFS；macOS
 *   virtiofs 不透传 socket connect），扫描保留为纵深防御；
 * - cgroup --memory/--cpus 提供硬资源上限，--memory-swap 与 --memory 等值
 *   冻结总 RAM+swap；所有 docker run（含版本探针）都带硬资源参数；
 * - OOM 机械判定全链失败关闭（Attempt 005）：daemon 前置验证 cgroup v2
 *   （docker info CgroupVersion，含 cgroup v1 拒绝），容器启动后
 *   memory.events 的 oom_kill 必须可机械读取，否则执行前
 *   RESOURCE_ISOLATION_UNSAFE；exec 前基线读取失败 → 不执行、失败关闭；
 *   非零退出后复读失败 → 保守映射 RESOURCE_MEMORY_LIMIT 并 docker rm -f；
 *   .State.OOMKilled 保留为佐证而非唯一证据；
 * - lifecycle 容器以 server 为 PID 1 主进程；仅无 lifecycle 的自建 runner
 *   路径使用 idle init 占住容器，使 exec 进程被 cgroup OOM 杀死时容器
 *   仍存活、memory.events 可机械复读；
 * - 容器名从 env 的 PLAYWRIGHT_JSON_OUTPUT_NAME 机械解析 run-[a-f0-9]+；
 * - env/args 中宿主绝对路径机械翻译：output root 前缀 → /e2e-output
 *   （容器可写层），root 前缀 → /work（ro 挂载）；注入
 *   PLAYWRIGHT_BROWSERS_PATH=/ms-playwright；PATH/HOME 不透传；
 * - secret env 经 --env-file（0600 临时文件）传递，不进入 docker CLI argv；
 * - runtime config 翻译仅支持 M5 内部固定生成形状
 *   defineConfig(<JSON.stringify(config)>)：解析 JSON 后递归仅改写
 *   output-root/root 前缀字符串值，翻译结果写入临时副本并 docker cp
 *   进容器 /e2e-run/，宿主原始 config 不被修改；畸形输入失败关闭；
 * - docker cp 回拷为 staging + 验证 + assemble-verify-swap 批次原子
 *   发布（Attempt 010/011，per-entry 发布/journal/目录 fd/硬链接
 *   装配全部移除）：
 *   cp 目标为 output root 同父目录下的 mkdtemp staging（同文件系统）；
 *   递归 lstat 验证只允许目录与有界普通文件，拒绝 symlink/FIFO/
 *   socket/device/其他类型、nlink>1 硬链接、entry 数/深度/单文件/总量
 *   超限及与执行前快照冲突的 entry（文件不得覆盖执行前制品，目录对
 *   目录允许合并）；验证返回身份表（目录 {type,dev,ino}，普通文件
 *   {type,dev,ino,size}，size 仅普通文件），装配 staging 时逐 entry
 *   重 lstat 全等比对（不符失败关闭）；
 *   装配一律 copyFileSync 全量字节拷贝（不用硬链接，新树 inode 与
 *   trash/staging 完全独立，经任何旧路径的原地写不再触及正式树）；
 *   expected 对普通文件绑定内容 sha256；换前对 outputRoot 做
 *   路径/类型/dev/ino/摘要全等复验（宿主并发增删换或内容编辑即
 *   失败关闭零污染）；两次 rename 交换（第二 rename 失败即换回
 *   原位）；trash 处置为全等复验（含摘要）+ 自底向上逐 entry 删除
 *   协议（文件 unlink、目录 rmdir 空目录；entry 缺失/身份或摘要不符/
 *   ENOTEMPTY/发现未验证 entry 任何异常即停，剩余保留原位，
 *   PARTIAL 如实外传，不做整树递归删除）。
 *   威胁模型声明（冻结）：对抗者 = 容器内不可信测试代码（无任何宿主
 *   可写挂载，已机械隔离）+ 事故级宿主并发（编辑器、构建工具等）。
 *   同 UID 宿主进程的 syscall 级主动竞态属于尽力加固范围：协议把
 *   每个窗口压到最小、每个检查失败关闭、任何异常如实上报，不承诺
 *   绝对封闭（纯用户态协议对该对抗者不存在绝对封闭）。
 *   已知残余（冻结记录）：
 *   - outputRoot 目录自身 inode 在 swap 后变化（目录 fd/监视器失效）；
 *     M5 output root 为执行产物目录，无持久 watcher 场景；
 *   - 两次 rename 之间存在极短的 outputRoot 缺失窗口（仅影响并发
 *     读者，无安全语义）；swap 失败即换回；
 *   - 容量门仍在 cp 后生效（docker cp 无内建配额，R8 已记录）。
 *   注：verifyStaging 导出仅供测试在「docker cp 先于验证失败」的平台
 *   （如 macOS 不可信 entry 提取 EPERM）直接覆盖验证阶段，与
 *   setCopyBackLimitsForTest/setPublishHookForTest 同受
 *   E2E_TEST_DOCKER_HOST_TEST_HOOKS 环境门保护；
 * - resourceObservation 来自 docker stats 轮询，mechanism
 *   docker-cgroup+stats:docker；宿主侧 timeout 映射 RESOURCE_TIMEOUT。
 *
 * 模块级配置：configureDockerExecutor 在任何宿主函数调用前由
 * browser-extension-runner（或测试）用冻结 plan 的 isolation/resources
 * 设置；未配置时所有宿主函数失败关闭。
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

const DOCKER_CLI = 'docker';
const CONTAINER_WORK_ROOT = '/work';
// 容器自身可写层中的输出根与 runtime config 位置（不挂载任何宿主目录）
const CONTAINER_OUTPUT_ROOT = '/e2e-output';
const CONTAINER_CONFIG_PATH = '/e2e-run/playwright.runtime.config.mjs';
const HEADLESS_SHELL_PATH =
  '/ms-playwright/chromium_headless_shell-1217/chrome-linux/headless_shell';
const BROWSER_VERSION_RE = /(\d+\.\d+\.\d+\.\d+)/;
const CONTAINER_NAME_RE = /^run-[a-f0-9]+$/;
const RESOURCE_OBSERVATION_MECHANISM = 'docker-cgroup+stats:docker';
// 仅自建（无 lifecycle）runner 路径使用 idle init 占住容器；lifecycle
// 容器以 server 为 PID 1 主进程
const IDLE_INIT_SCRIPT = 'setInterval(()=>{},1e9)';
// 版本探针的固定小额硬资源参数（所有 docker run 都有硬资源参数）
const VERSION_PROBE_MEMORY_MB = 512;
const VERSION_PROBE_CPUS = 1;
// docker cp 回拷验证的有界限制（取值兼容真实 playwright trace.zip 量级）
const COPY_BACK_LIMITS = Object.freeze({
  maxEntries: 10000,
  maxDepth: 32,
  maxFileBytes: 1024 * 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024 * 1024,
});

// 生效中的回拷限制（默认即冻结常量；仅测试可通过
// setCopyBackLimitsForTest 注入小常量构造超限负例）
let copyBackLimits = { ...COPY_BACK_LIMITS };

/**
 * 测试钩子环境门：仅 E2E_TEST_DOCKER_HOST_TEST_HOOKS === '1' 时
 * 测试注入 API 可用；生产调用方不设置即调用即抛错。
 */
function requireTestHooks(callerName) {
  if (process.env.E2E_TEST_DOCKER_HOST_TEST_HOOKS !== '1') {
    throw new Error(
      `${callerName} 仅供测试：需要 E2E_TEST_DOCKER_HOST_TEST_HOOKS === '1'`,
    );
  }
}

/**
 * 仅测试使用：临时覆盖回拷限制以构造小常量超限负例，
 * 返回恢复函数。生产代码路径不得调用；受
 * E2E_TEST_DOCKER_HOST_TEST_HOOKS 环境门保护。
 * @param {Partial<typeof COPY_BACK_LIMITS>} overrides
 * @returns {() => void} 恢复函数
 */
export function setCopyBackLimitsForTest(overrides) {
  requireTestHooks('setCopyBackLimitsForTest');
  const saved = copyBackLimits;
  copyBackLimits = { ...COPY_BACK_LIMITS, ...overrides };
  return () => {
    copyBackLimits = saved;
  };
}

// ─── 模块级隔离配置 ───

/** @type {{ image: string, resources: { cpu: number, memMB: number } }|null} */
let configuredIsolation = null;

/**
 * 用冻结 plan 的 isolation/resources 配置 docker 执行器。
 * 形状畸形直接抛错，不保留半配置状态。
 * @param {{ isolation: object, resources: object }} input
 */
export function configureDockerExecutor({ isolation, resources } = {}) {
  if (!isolation || isolation.executor !== 'docker' ||
      typeof isolation.image !== 'string' || isolation.image.length === 0) {
    throw new Error('configureDockerExecutor: isolation 必须是 { executor: "docker", image: 非空字符串 }');
  }
  if (!resources || typeof resources.cpu !== 'number' ||
      !Number.isFinite(resources.cpu) || resources.cpu <= 0 ||
      !Number.isInteger(resources.memMB) || resources.memMB < 128) {
    throw new Error('configureDockerExecutor: resources 预算畸形');
  }
  configuredIsolation = {
    image: isolation.image,
    resources: { cpu: resources.cpu, memMB: resources.memMB },
  };
}

/** 已配置镜像；未配置时抛错。 */
function requireConfigured() {
  if (!configuredIsolation) {
    throw new Error('docker executor 未配置：缺少 configureDockerExecutor');
  }
  return configuredIsolation;
}

// ─── daemon / 镜像 / cgroup 前置检查（副作用前失败关闭，禁止 pull） ───

/** docker daemon 可用性；不可用抛出带 M5_ISOLATION_UNAVAILABLE 的错误。 */
function assertDockerDaemon() {
  try {
    execFileSync(DOCKER_CLI, ['info', '--format', '{{.ServerVersion}}'], {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
  } catch (error) {
    const failure = new Error(`docker daemon 不可用: ${error.message}`);
    failure.code = 'M5_ISOLATION_UNAVAILABLE';
    throw failure;
  }
}

/** 冻结镜像必须预先存在于本机；缺失抛错，禁止 docker pull。 */
function assertImagePresent(image) {
  try {
    execFileSync(DOCKER_CLI, ['image', 'inspect', image, '--format', '{{.Id}}'], {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
  } catch (error) {
    const failure = new Error(`docker 镜像缺失且禁止自动拉取: ${image}: ${error.message}`);
    failure.code = 'M5_ISOLATION_UNAVAILABLE';
    throw failure;
  }
}

/**
 * daemon 级 cgroup v2 前置验证：OOM 机械判定依赖 cgroup v2
 * memory.events；cgroup v1 或字段不可解析一律失败关闭
 * （RESOURCE_ISOLATION_UNSAFE），先于任何容器启动。
 */
function assertCgroupV2Daemon() {
  let output;
  try {
    output = execFileSync(DOCKER_CLI, [
      'info', '--format', '{{.CgroupVersion}}',
    ], {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
  } catch (error) {
    const failure = new Error(`cgroup 版本探测失败，失败关闭: ${error.message}`);
    failure.code = 'RESOURCE_ISOLATION_UNSAFE';
    throw failure;
  }
  if (output.trim() !== '2') {
    const failure = new Error(
      `docker daemon 不是 cgroup v2（CgroupVersion=${output.trim()}），` +
      'memory.events OOM 机械判定不可用，失败关闭',
    );
    failure.code = 'RESOURCE_ISOLATION_UNSAFE';
    throw failure;
  }
}

/**
 * 无副作用的可用性检查，供 browser-extension-runner 在任何执行副作用前
 * 以 M5_ISOLATION_UNAVAILABLE 失败关闭。
 * @param {object} isolation
 * @returns {{ ok: boolean, error?: string }}
 */
export function checkDockerIsolation(isolation) {
  if (!isolation || isolation.executor !== 'docker' ||
      typeof isolation.image !== 'string' || isolation.image.length === 0) {
    return { ok: false, error: 'isolation 必须是 { executor: "docker", image: 非空字符串 }' };
  }
  try {
    assertDockerDaemon();
    assertImagePresent(isolation.image);
    assertCgroupV2Daemon();
  } catch (error) {
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

// ─── 内部辅助 ───

/**
 * 同步有界等待，使用 Atomics.wait，不得派生 Node sleep 子进程。
 * @param {number} ms 等待毫秒数
 */
function boundedWait(ms) {
  const sab = new SharedArrayBuffer(4);
  const int32 = new Int32Array(sab);
  Atomics.wait(int32, 0, 0, ms);
}

/**
 * 从 env 的 PLAYWRIGHT_JSON_OUTPUT_NAME 机械解析容器名 run-[a-f0-9]+。
 * 解析失败抛错，不回退。
 * @param {object} env
 * @returns {string}
 */
function containerNameFromEnv(env) {
  const outputName = env?.PLAYWRIGHT_JSON_OUTPUT_NAME;
  const match = typeof outputName === 'string'
    ? outputName.match(/run-[a-f0-9]+/)
    : null;
  if (!match || !CONTAINER_NAME_RE.test(match[0])) {
    throw new Error('containerNameFromEnv: PLAYWRIGHT_JSON_OUTPUT_NAME 中无法解析 run-[a-f0-9]+ 容器名');
  }
  return match[0];
}

/**
 * 宿主绝对路径机械翻译：output root 前缀 → /e2e-output（容器可写层，
 * 先匹配更具体前缀），root 前缀 → /work（ro 挂载）；其余原样保留。
 */
function translateExecPath(value, root, outputRoot) {
  if (typeof value !== 'string') return value;
  if (outputRoot) {
    if (value === outputRoot) return CONTAINER_OUTPUT_ROOT;
    if (value.startsWith(`${outputRoot}/`)) {
      return `${CONTAINER_OUTPUT_ROOT}${value.slice(outputRoot.length)}`;
    }
  }
  if (value === root) return CONTAINER_WORK_ROOT;
  if (value.startsWith(`${root}/`)) {
    return `${CONTAINER_WORK_ROOT}${value.slice(root.length)}`;
  }
  return value;
}

/**
 * 挂载卫生门：机械扫描项目根（含 node_modules）下的 Unix socket。
 * output root 不再挂载进容器后，扫描-挂载时间窗已消除；本门保留为
 * 纵深防御。任何 socket 或 find 失败一律失败关闭
 * （RESOURCE_ISOLATION_UNSAFE），零副作用。
 * @param {string} root 已 realpath 的项目根
 */
function assertNoUnixSockets(root) {
  let output;
  try {
    output = execFileSync('/usr/bin/find', [root, '-type', 's', '-print'], {
      encoding: 'utf8',
      timeout: 60000,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
  } catch (error) {
    const failure = new Error(`Unix socket 扫描失败，失败关闭: ${error.message}`);
    failure.code = 'RESOURCE_ISOLATION_UNSAFE';
    throw failure;
  }
  const found = output.split('\n').map(line => line.trim()).filter(Boolean);
  if (found.length > 0) {
    const failure = new Error(
      `项目根存在 Unix socket，挂载会暴露宿主 AF_UNIX 旁路: ${found[0]}`,
    );
    failure.code = 'RESOURCE_ISOLATION_UNSAFE';
    throw failure;
  }
}

/**
 * M5 隔离 output root 的宿主绝对路径（PLAYWRIGHT_JSON_OUTPUT_NAME 的
 * 目录部分，即 .artifact-graph/runs/e2e-test/<runId>）。不再挂载进容器，
 * 仅作为成功路径 docker cp 拷贝回宿主的目标；宿主目录必须已存在。
 */
function ensureOutputRoot(env) {
  const outputName = env?.PLAYWRIGHT_JSON_OUTPUT_NAME;
  if (typeof outputName !== 'string' || !outputName) {
    throw new Error('ensureOutputRoot: PLAYWRIGHT_JSON_OUTPUT_NAME 缺失');
  }
  const outputRoot = dirname(outputName);
  if (!existsSync(outputRoot)) {
    mkdirSync(outputRoot, { recursive: true });
  }
  return outputRoot;
}

/**
 * 把 env 翻译后写入 0600 临时 env-file，返回路径。
 * PATH/HOME 不透传（容器使用自身默认）；注入
 * PLAYWRIGHT_BROWSERS_PATH=/ms-playwright；值含换行时失败关闭。
 */
function writeEnvFile(env, root, outputRoot, directory) {
  const lines = [];
  for (const [key, rawValue] of Object.entries(env || {})) {
    // PATH/HOME 不透传；测试钩子变量显式剔除，不传入容器（纵深防御）
    if (key === 'PATH' || key === 'HOME' ||
        key === 'E2E_TEST_DOCKER_HOST_TEST_HOOKS') continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`writeEnvFile: 非法 env 名: ${JSON.stringify(key)}`);
    }
    const value = translateExecPath(String(rawValue), root, outputRoot);
    if (value.includes('\n') || value.includes('\r')) {
      throw new Error(`writeEnvFile: env 值含换行: ${key}`);
    }
    lines.push(`${key}=${value}`);
  }
  lines.push('PLAYWRIGHT_BROWSERS_PATH=/ms-playwright');
  const file = join(directory, 'container.env');
  writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  return file;
}

/**
 * 精确匹配名的容器是否存在（含已退出）。
 * @param {string} name
 * @returns {boolean}
 */
function containerExists(name) {
  const output = execFileSync(DOCKER_CLI, [
    'ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}',
  ], {
    encoding: 'utf8',
    timeout: 15000,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });
  return output.split('\n').map(line => line.trim()).includes(name);
}

/** 容器是否处于 running。 */
function containerRunning(name) {
  const output = execFileSync(DOCKER_CLI, [
    'ps', '--filter', `name=^/${name}$`, '--format', '{{.Names}}',
  ], {
    encoding: 'utf8',
    timeout: 15000,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });
  return output.split('\n').map(line => line.trim()).includes(name);
}

/** 内核级终止并删除容器；容器不存在视为已清理。 */
function removeContainer(name) {
  try {
    execFileSync(DOCKER_CLI, ['rm', '-f', name], {
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
  } catch (error) {
    if (/No such container/i.test(String(error.stderr || error.message))) return;
    throw error;
  }
}

/** 读取容器 OOMKilled 标记（佐证而非唯一证据）；容器不存在返回 false。 */
function containerOomKilled(name) {
  let output;
  try {
    output = execFileSync(DOCKER_CLI, [
      'inspect', '--format', '{{.State.OOMKilled}}', name,
    ], {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
  } catch {
    return false;
  }
  return output.trim() === 'true';
}

/**
 * 机械读取容器 cgroup v2 memory.events 的 oom_kill 计数。
 * 返回 null 表示证据不可用（容器不存在/退出、cgroup v1、字段缺失、
 * 输出不可解析）；调用方必须失败关闭，不得静默降级：
 * - exec 前基线为 null → 不执行，RESOURCE_ISOLATION_UNSAFE；
 * - 非零退出后复读为 null → 保守映射 RESOURCE_MEMORY_LIMIT。
 * @param {string} name
 * @returns {number|null}
 */
function readOomKillCount(name) {
  let output;
  try {
    output = execFileSync(DOCKER_CLI, [
      'exec', name, 'cat', '/sys/fs/cgroup/memory.events',
    ], {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
  } catch {
    return null;
  }
  const match = output.match(/^oom_kill (\d+)$/m);
  if (!match) return null;
  return Number(match[1]);
}

// ─── docker stats 采样 ───

/**
 * 采样器子进程脚本：周期执行 docker stats --no-stream --format '{{json .}}'
 * 并机械解析 CPUPerc/MemUsage，把 {cpu, memMB} JSON 行追加到样本文件。
 * 容器尚未出现或 stats 失败的周期跳过，不回退不补值。
 */
const STATS_SAMPLER_SCRIPT = `
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const name = process.argv[1];
const outFile = process.argv[2];
const UNIT_MB = { B: 1 / 1048576, KiB: 1 / 1024, MiB: 1, GiB: 1024, TiB: 1048576 };
function sample() {
  let line;
  try {
    line = execFileSync('docker', [
      'stats', '--no-stream', '--format', '{{json .}}', name,
    ], { encoding: 'utf8', timeout: 8000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return;
  }
  if (!line) return;
  let parsed;
  try {
    parsed = JSON.parse(line.split('\\n')[0]);
  } catch {
    return;
  }
  const cpu = Number(String(parsed.CPUPerc || '').replace('%', '')) / 100;
  const memMatch = String(parsed.MemUsage || '').split('/')[0].trim()
    .match(/^([0-9.]+)([A-Za-z]+)$/);
  if (!memMatch) return;
  const factor = UNIT_MB[memMatch[2]];
  if (factor === undefined) return;
  const memMB = Number(memMatch[1]) * factor;
  if (!Number.isFinite(cpu) || cpu < 0 || !Number.isFinite(memMB) || memMB < 0) return;
  fs.appendFileSync(outFile, JSON.stringify({ cpu, memMB }) + '\\n');
}
sample();
setInterval(sample, 150);
`;

/**
 * 启动 stats 采样器子进程，返回 { sampler, sampleFile, cleanup }。
 * cleanup 终止采样器并机械聚合峰值；畸形样本行抛错，不静默吞掉。
 */
function startStatsSampler(name, directory) {
  const sampleFile = join(directory, 'stats-samples.jsonl');
  writeFileSync(sampleFile, '', { mode: 0o600 });
  const sampler = spawn(process.execPath, [
    '-e', STATS_SAMPLER_SCRIPT, name, sampleFile,
  ], {
    stdio: 'ignore',
    shell: false,
  });
  let cleaned = false;
  function cleanup() {
    if (cleaned) return aggregateSamples(sampleFile);
    cleaned = true;
    try {
      sampler.kill('SIGKILL');
    } catch {}
    // 等待最后一个进行中的 stats 周期落盘
    boundedWait(200);
    return aggregateSamples(sampleFile);
  }
  return { sampler, sampleFile, cleanup };
}

/** 机械聚合样本峰值；非空行必须是合法 {cpu, memMB} JSON。 */
function aggregateSamples(sampleFile) {
  let cpuPeak = 0;
  let memPeakMB = 0;
  let sampleCount = 0;
  const content = readFileSync(sampleFile, 'utf8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const sample = JSON.parse(line);
    if (typeof sample?.cpu !== 'number' || !Number.isFinite(sample.cpu) ||
        sample.cpu < 0 ||
        typeof sample?.memMB !== 'number' || !Number.isFinite(sample.memMB) ||
        sample.memMB < 0) {
      throw new Error(`aggregateSamples: 畸形样本行: ${JSON.stringify(line)}`);
    }
    if (sample.cpu > cpuPeak) cpuPeak = sample.cpu;
    if (sample.memMB > memPeakMB) memPeakMB = sample.memMB;
    sampleCount++;
  }
  return { cpuPeak, memPeakMB, sampleCount };
}

function makeResourceObservation(peaks) {
  return {
    mechanism: RESOURCE_OBSERVATION_MECHANISM,
    cpuPeak: peaks.cpuPeak,
    memPeakMB: peaks.memPeakMB,
    sampleCount: peaks.sampleCount,
  };
}

// ─── runtime config 结构化翻译 ───

/** 递归改写：仅把 output-root/root 前缀的字符串值翻译为容器路径。 */
function rewriteRootPrefixedStrings(value, root, outputRoot) {
  if (typeof value === 'string') return translateExecPath(value, root, outputRoot);
  if (Array.isArray(value)) {
    return value.map(item => rewriteRootPrefixedStrings(item, root, outputRoot));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .map(([key, item]) => [key, rewriteRootPrefixedStrings(item, root, outputRoot)]));
  }
  return value;
}

/**
 * runtime config 结构化翻译。窄输入契约：仅支持 M5 内部固定生成形状
 *   import { defineConfig } from '@playwright/test';
 *   export default defineConfig(<JSON.stringify(config)>);
 * 定位 defineConfig( 与末尾 ) 之间的 JSON，JSON.parse 后递归仅改写
 * output-root/root 前缀字符串值，重序列化写入临时副本返回副本路径；
 * 宿主原始 config 不被修改。缺标记、多 defineConfig、注释/模板字符串
 * 或非法 JSON 一律抛错失败关闭，不做全文 split/join。
 * @returns {string} 翻译后副本的宿主临时路径
 */
function translateRuntimeConfigToCopy(configPath, root, outputRoot, directory) {
  const raw = readFileSync(configPath, 'utf8');
  const marker = 'defineConfig(';
  const jsonStart = raw.indexOf(marker);
  if (jsonStart === -1) {
    throw new Error('translateRuntimeConfig: 缺少 defineConfig( 标记');
  }
  const jsonEnd = raw.lastIndexOf(')');
  if (jsonEnd <= jsonStart + marker.length) {
    throw new Error('translateRuntimeConfig: defineConfig(...) 区域畸形');
  }
  const parsed = JSON.parse(raw.slice(jsonStart + marker.length, jsonEnd));
  const translated = rewriteRootPrefixedStrings(parsed, root, outputRoot);
  const output =
    raw.slice(0, jsonStart + marker.length) +
    JSON.stringify(translated) +
    raw.slice(jsonEnd);
  const copyPath = join(directory, 'playwright.runtime.config.mjs');
  writeFileSync(copyPath, output, { mode: 0o600 });
  return copyPath;
}

// ─── docker cp 回拷：staging + 验证 + 受控发布 ───

/** 不可信内容拒绝（RESOURCE_ISOLATION_UNSAFE）。 */
function unsafeContent(message) {
  const failure = new Error(message);
  failure.code = 'RESOURCE_ISOLATION_UNSAFE';
  return failure;
}

/** cp/IO/发布失败（RESOURCE_CLEANUP_FAILED）。 */
function copyFailure(message) {
  const failure = new Error(message);
  failure.code = 'RESOURCE_CLEANUP_FAILED';
  return failure;
}

/**
 * 执行前快照 output root 已存在的相对路径集合（rel → 'dir'|'file'）。
 * 宿主执行前状态是受信的；快照用于回拷验证的覆盖保护——文件不得
 * 覆盖执行前已存在的制品（runtime config 等），目录对目录允许合并
 * （M5 在执行前已创建 artifacts/ 等目录）。
 * @param {string} outputRoot
 * @returns {Map<string, string>}
 */
function snapshotOutputRoot(outputRoot) {
  const entries = new Map();
  const walk = (dir, relBase) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const rel = relBase ? `${relBase}/${entry}` : entry;
      const stat = lstatSync(full);
      if (stat.isDirectory()) {
        entries.set(rel, 'dir');
        walk(full, rel);
      } else {
        entries.set(rel, 'file');
      }
    }
  };
  walk(outputRoot, '');
  return entries;
}

/**
 * 递归 lstat 验证 staging 内容（容器侧输出不可信）：
 * - 只允许目录与普通文件；拒绝 symlink、FIFO、socket、device 及其他类型；
 * - 拒绝 nlink > 1 的普通文件（硬链接）；
 * - entry 总数、目录深度、单文件字节数、总字节数有界；
 * - 与执行前快照冲突的 entry 一律拒绝（文件不得覆盖执行前制品；
 *   目录对目录允许合并）。
 * 任何违反抛 RESOURCE_ISOLATION_UNSAFE；遍历 IO 失败抛
 * RESOURCE_CLEANUP_FAILED。
 * 导出仅供测试：在 docker cp 先于验证失败的平台（如 macOS 不可信
 * entry 提取 EPERM）对验证阶段做直接真实负例覆盖；受
 * E2E_TEST_DOCKER_HOST_TEST_HOOKS 环境门保护（内部调用走
 * verifyStagingInternal，不经门禁）。
 */
export function verifyStaging(staging, preSnapshot) {
  requireTestHooks('verifyStaging');
  return verifyStagingInternal(staging, preSnapshot);
}

function verifyStagingInternal(staging, preSnapshot) {
  // 验证同时建立身份表：目录 rel → {type, dev, ino}，普通文件
  // rel → {type, dev, ino, size}（size 仅普通文件）；装配 staging 时
  // 逐 entry 重新 lstat 全等比对，绑定「验证时对象 = 装配时对象」
  const identity = new Map();
  let entryCount = 0;
  let totalBytes = 0;
  const walk = (dir, relBase, depth) => {
    let names;
    try {
      names = readdirSync(dir);
    } catch (error) {
      throw copyFailure(`staging 目录不可读: ${dir}: ${error.message}`);
    }
    for (const entry of names) {
      const full = join(dir, entry);
      const rel = relBase ? `${relBase}/${entry}` : entry;
      entryCount++;
      if (entryCount > copyBackLimits.maxEntries) {
        throw unsafeContent(`staging entry 总数超限（>${copyBackLimits.maxEntries}）`);
      }
      if (depth > copyBackLimits.maxDepth) {
        throw unsafeContent(`staging 目录深度超限（>${copyBackLimits.maxDepth}）: ${rel}`);
      }
      let stat;
      try {
        stat = lstatSync(full);
      } catch (error) {
        throw copyFailure(`staging entry 不可观测: ${rel}: ${error.message}`);
      }
      if (stat.isSymbolicLink()) {
        throw unsafeContent(`staging 含 symlink，失败关闭: ${rel}`);
      }
      if (stat.isDirectory()) {
        const pre = preSnapshot.get(rel);
        if (pre !== undefined && pre !== 'dir') {
          throw unsafeContent(`staging 目录与执行前文件制品冲突: ${rel}`);
        }
        identity.set(rel, { type: 'dir', dev: stat.dev, ino: stat.ino });
        walk(full, rel, depth + 1);
        continue;
      }
      if (!stat.isFile()) {
        throw unsafeContent(`staging 含非普通文件 entry（FIFO/socket/device 等）: ${rel}`);
      }
      if (stat.nlink > 1) {
        throw unsafeContent(`staging 含硬链接 entry（nlink=${stat.nlink}）: ${rel}`);
      }
      if (stat.size > copyBackLimits.maxFileBytes) {
        throw unsafeContent(`staging 单文件字节超限（>${copyBackLimits.maxFileBytes}）: ${rel}`);
      }
      totalBytes += stat.size;
      if (totalBytes > copyBackLimits.maxTotalBytes) {
        throw unsafeContent(`staging 总字节超限（>${copyBackLimits.maxTotalBytes}）`);
      }
      if (preSnapshot.has(rel)) {
        throw unsafeContent(`staging 文件与执行前制品冲突，拒绝覆盖: ${rel}`);
      }
      identity.set(rel, {
        type: 'file',
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
      });
    }
  };
  walk(staging, '', 1);
  return identity;
}

/**
 * 批次原子发布：assemble-verify-swap（Attempt 010/011，取代 per-entry
 * 向活目录发布 + journal/逆序回滚/目录 fd 钉住/硬链接装配路线）：
 * 1. 装配：在 outputRoot 同父目录 mkdtemp 新建 .assemble-*，先遍历
 *    outputRoot 记录期望前态 expected（rel → {type, dev, ino}，普通
 *    文件附内容 sha256），并把完整最终树装配进 assemble：已有 entry
 *    目录 mkdir、文件 copyFileSync 全量字节拷贝（不用硬链接，新树
 *    inode 与 trash/staging 完全独立），再把验证通过的 staging entry
 *    按验证身份表逐 entry 重 lstat 绑定后同样拷贝装配（staging 与
 *    已有 entry 的冲突已在验证拒绝，assemble 从空开始，冲突不可能
 *    发生）；
 * 2. 换前复验：再次遍历 outputRoot 与 expected 全等比对（路径/类型/
 *    dev/ino/内容摘要），宿主并发增/删/替换/内容编辑即失败关闭
 *    RESOURCE_ISOLATION_UNSAFE，删 assemble 与 staging，正式
 *    outputRoot 零污染（此阶段尚未触碰它）；
 * 3. 交换：renameSync(outputRoot → .trash-*) 后
 *    renameSync(assemble → outputRoot)；第二 rename 失败立即把
 *    trash 换回原位（RESOURCE_CLEANUP_FAILED + COMPLETE），换回也
 *    失败则 trash 保留 + PARTIAL 如实上报；
 * 4. trash 处置：全等复验（含内容摘要）后自底向上逐 entry 删除
 *    （文件 unlink、目录 rmdir 空目录）；entry 缺失、身份/摘要不符、
 *    ENOTEMPTY、发现未验证 entry 任何异常立即停止，trash 剩余保留
 *    原位，RESOURCE_CLEANUP_FAILED + PARTIAL 明细经 rollback 字段
 *    如实外传（绝不删除未验证对象，不做整树递归删除）；
 *    全部删尽即 COMPLETE（成功路径无 rollback 字段）。
 * rollback 字段语义沿用：{status:'COMPLETE'} /
 * {status:'PARTIAL', errors:[...]}，透传链不变。
 */

/**
 * 递归遍历目录树，返回 rel → { type, dev, ino } 身份映射。
 * type 为 'dir' | 'file' | 'other'（symlink/FIFO/socket/device 等）。
 * entry 按字典序处理保证顺序确定。
 */
function walkTreeIdentity(rootDir) {
  const entries = new Map();
  const walk = (dir, relBase) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      const rel = relBase ? `${relBase}/${entry}` : entry;
      const stat = lstatSync(full);
      if (stat.isDirectory()) {
        entries.set(rel, { type: 'dir', dev: stat.dev, ino: stat.ino });
        walk(full, rel);
      } else if (stat.isFile()) {
        // 普通文件绑定内容 sha256：同 inode 原地写（截断/覆写/追加）
        // 也可被换前复验与 trash 复验发现
        entries.set(rel, {
          type: 'file',
          dev: stat.dev,
          ino: stat.ino,
          sha256: createHash('sha256').update(readFileSync(full)).digest('hex'),
        });
      } else {
        entries.set(rel, { type: 'other', dev: stat.dev, ino: stat.ino });
      }
    }
  };
  walk(rootDir, '');
  return entries;
}

/**
 * 两棵身份树全等比对，返回不一致明细（空数组 = 全等）。
 * 增（新增）、删（已删除）、换（对象已替换：类型/dev/ino 任一变化）、
 * 内容编辑（同 inode 原地写：sha256 不符）。
 */
function diffTreeIdentity(expected, current) {
  const mismatches = [];
  for (const [rel, exp] of expected) {
    const cur = current.get(rel);
    if (!cur) {
      mismatches.push(`${rel}:已删除`);
      continue;
    }
    if (cur.type !== exp.type || cur.dev !== exp.dev || cur.ino !== exp.ino) {
      mismatches.push(`${rel}:对象已替换`);
      continue;
    }
    if (exp.type === 'file' && cur.sha256 !== exp.sha256) {
      mismatches.push(`${rel}:内容已编辑`);
    }
  }
  for (const rel of current.keys()) {
    if (!expected.has(rel)) {
      mismatches.push(`${rel}:新增`);
    }
  }
  return mismatches;
}

/**
 * 把 outputRoot 现有完整树装配进 assemble（目录 mkdir、文件
 * copyFileSync 全量字节拷贝——不用硬链接，新树 inode 与
 * trash/staging 完全独立，经任何旧路径的原地写不再触及正式树）。
 * 现有树含非 dir/file entry（symlink/FIFO 等）属环境异常，失败关闭。
 */
function assembleExistingTree(outputRoot, assemble, expected) {
  for (const [rel, entry] of expected) {
    const source = join(outputRoot, rel);
    const target = join(assemble, rel);
    try {
      if (entry.type === 'dir') {
        mkdirSync(target);
      } else if (entry.type === 'file') {
        copyFileSync(source, target);
      } else {
        throw unsafeContent(`装配：outputRoot 含非 dir/file entry: ${rel}`);
      }
    } catch (error) {
      if (error.code === 'RESOURCE_ISOLATION_UNSAFE') throw error;
      throw copyFailure(`装配已有树失败: ${rel}: ${error.message}`);
    }
  }
}

/**
 * 把验证通过的 staging entry 装配进 assemble：逐 entry 重新 lstat
 * 并与 verifyStagingInternal 返回的验证身份表全等比对（类型/dev/
 * ino/size，绑定「验证时对象 = 装配时对象」），不符即失败关闭；
 * 目录 mkdir 合并、文件 copyFileSync 全量字节拷贝。staging 与已有
 * entry 的冲突已在验证阶段拒绝，assemble 从空开始，冲突不可能发生。
 */
function assembleStagingTree(staging, assemble, stagingIdentity) {
  for (const [rel, entry] of stagingIdentity) {
    const source = join(staging, rel);
    const target = join(assemble, rel);
    let stat;
    try {
      stat = lstatSync(source);
    } catch (error) {
      throw unsafeContent(`装配绑定：staging entry 验证后被移除: ${rel}: ${error.message}`);
    }
    if (entry.type === 'dir') {
      if (!stat.isDirectory() || stat.dev !== entry.dev || stat.ino !== entry.ino) {
        throw unsafeContent(`装配绑定：staging 目录验证后被替换: ${rel}`);
      }
    } else if (!stat.isFile() || stat.dev !== entry.dev ||
        stat.ino !== entry.ino || stat.size !== entry.size) {
      throw unsafeContent(`装配绑定：staging 文件验证后被替换或编辑: ${rel}`);
    }
    try {
      if (entry.type === 'dir') {
        if (!existsSync(target)) {
          mkdirSync(target);
        }
      } else {
        copyFileSync(source, target);
      }
    } catch (error) {
      throw copyFailure(`装配 staging 失败: ${rel}: ${error.message}`);
    }
  }
}

/** 生成同父目录下不存在的随机名（mkdtemp 占位后 rmdir 释放名称）。 */
function freshSiblingName(parentDir, prefix) {
  const probe = mkdtempSync(join(parentDir, prefix));
  rmdirSync(probe);
  return probe;
}

/**
 * 仅测试的发布阶段钩子（E2E_TEST_DOCKER_HOST_TEST_HOOKS 环境门
 * 保护）：注册后在指定机械点被同步调用，供测试确定性构造宿主并发
 * 行为，替代竞态 watcher。生产无注册即无调用。返回注销函数。
 * 机械点：
 * - 'pre-assemble-staging'：staging 验证完成后、装配绑定前
 *   （context: { staging }）；
 * - 'pre-swap-verify'：装配完成后、换前复验前
 *   （context: { outputRoot, staging, assemble }）；
 * - 'pre-trash-verify'：swap 成功后、trash 全等复验前
 *   （context: { outputRoot, trash }）；
 * - 'pre-trash-delete'：trash 复验全等后、逐 entry 删除协议前
 *   （context: { trash }）。
 * @param {null|((point: string, context: object) => void)} hook
 * @returns {() => void}
 */
let publishHookForTest = null;
export function setPublishHookForTest(hook) {
  requireTestHooks('setPublishHookForTest');
  publishHookForTest = hook;
  return () => {
    publishHookForTest = null;
  };
}

function callPublishHook(point, context) {
  if (publishHookForTest) {
    publishHookForTest(point, context);
  }
}

/**
 * swap rename（含测试构造钩子：仅 E2E_TEST_DOCKER_HOST_TEST_HOOKS='1'
 * 且 E2E_TEST_DOCKER_HOST_SWAP_FAIL === tag 时注入 EPERM 失败，
 * 供测试确定性构造 swap 第一/第二 rename 失败；生产无此环境变量即
 * 无注入）。tag ∈ 'first' | 'second'。
 */
function swapRenameSync(source, target, tag) {
  if (process.env.E2E_TEST_DOCKER_HOST_TEST_HOOKS === '1' &&
      process.env.E2E_TEST_DOCKER_HOST_SWAP_FAIL === tag) {
    const failure = new Error(`test-injected swap ${tag} rename failure`);
    failure.code = 'EPERM';
    throw failure;
  }
  renameSync(source, target);
}

/**
 * trash 逐 entry 删除协议（替代 rmSync recursive 整树删除，闭合
 * 复验→删除 TOCTOU）：后序遍历收集实际树，自底向上逐 entry 处理——
 * 每个 entry 删除前重新 lstat 绑定身份（类型/dev/ino），普通文件再
 * 重算 sha256 绑定内容；文件 unlinkSync、目录 rmdirSync（仅空目录
 * 可删）。entry 缺失、身份/摘要不符、ENOTEMPTY、发现未验证 entry
 * 任何异常立即停止，返回已发生的错误明细；调用方据此保留 trash
 * 剩余原位并 PARTIAL 外传。全部删尽（含 trash 根目录）返回空 errors。
 * @param {string} trash
 * @param {Map<string, object>} expected rel → {type, dev, ino, sha256?}
 * @returns {{ errors: string[] }}
 */
function deleteTrashEntries(trash, expected) {
  const errors = [];
  // 后序遍历收集实际树（子 entry 先于父目录）
  const actual = [];
  const collect = (dir, relBase) => {
    let names;
    try {
      names = readdirSync(dir);
    } catch (error) {
      errors.push(`${relBase || '.'}:删除协议遍历失败:${error.message}`);
      return false;
    }
    for (const entry of names.sort()) {
      const full = join(dir, entry);
      const rel = relBase ? `${relBase}/${entry}` : entry;
      let stat;
      try {
        stat = lstatSync(full);
      } catch (error) {
        errors.push(`${rel}:删除协议观测失败:${error.message}`);
        return false;
      }
      if (stat.isDirectory()) {
        if (!collect(full, rel)) return false;
        actual.push({ rel, full, type: 'dir' });
      } else {
        actual.push({ rel, full, type: stat.isFile() ? 'file' : 'other' });
      }
    }
    return true;
  };
  if (!collect(trash, '')) {
    return { errors };
  }

  const visited = new Set();
  for (const entry of actual) {
    const exp = expected.get(entry.rel);
    if (!exp) {
      errors.push(`${entry.rel}:发现未验证 entry，停止删除`);
      return { errors };
    }
    visited.add(entry.rel);
    // 删除前重新绑定身份（闭合复验→删除窗口）
    let current;
    try {
      current = lstatSync(entry.full);
    } catch (error) {
      errors.push(`${entry.rel}:删除前身份观测失败:${error.message}`);
      return { errors };
    }
    const currentType = current.isDirectory()
      ? 'dir'
      : current.isFile() ? 'file' : 'other';
    if (currentType !== exp.type ||
        current.dev !== exp.dev || current.ino !== exp.ino) {
      errors.push(`${entry.rel}:删除前身份不符（宿主并发替换），停止删除`);
      return { errors };
    }
    if (exp.type === 'file') {
      let sha256;
      try {
        sha256 = createHash('sha256')
          .update(readFileSync(entry.full))
          .digest('hex');
      } catch (error) {
        errors.push(`${entry.rel}:删除前内容读取失败:${error.message}`);
        return { errors };
      }
      if (sha256 !== exp.sha256) {
        errors.push(`${entry.rel}:删除前内容摘要不符（宿主并发编辑），停止删除`);
        return { errors };
      }
    }
    try {
      if (entry.type === 'file') {
        unlinkSync(entry.full);
      } else if (entry.type === 'dir') {
        rmdirSync(entry.full);
      } else {
        errors.push(`${entry.rel}:删除前类型异常（非 dir/file），停止删除`);
        return { errors };
      }
    } catch (error) {
      errors.push(`${entry.rel}:删除失败:${error.message}`);
      return { errors };
    }
  }

  // expected entry 缺失（宿主并发移除整棵子树）即停
  const missing = [...expected.keys()].filter(rel => !visited.has(rel));
  if (missing.length > 0) {
    errors.push(`${missing[0]}:entry 缺失（宿主并发移除），停止删除`);
    return { errors };
  }

  // 收尾删除 trash 根目录（仅空目录可删；复验后注入会让此步
  // ENOTEMPTY 失败，剩余保留）
  try {
    rmdirSync(trash);
  } catch (error) {
    errors.push(`.:trash 根目录删除失败:${error.message}`);
    return { errors };
  }
  return { errors };
}

/**
 * 回拷：docker cp → staging → 递归 lstat 验证 → assemble-verify-swap
 * 批次原子发布。
 * 任何失败删除 staging 与 assemble；cp/验证/换前复验失败时正式
 * output root 保持执行前状态（零污染）；swap 第二 rename 失败换回
 * 原位；trash 一旦创建即默认保留（唯一删除途径是验证全等后的逐
 * entry 删除协议），复验异常/不等或删除协议中止时不删除任何未
 * 完整验证的对象，trash 保留原位并经 rollback 字段 PARTIAL 如实外传。
 * @returns {{ errorCode: string|null, detail?: string, rollback?: object }}
 */
function publishContainerOutput(name, outputRoot, preSnapshot) {
  const staging = mkdtempSync(join(dirname(outputRoot), '.cp-staging-'));
  let assemble = null;
  // trash 一旦创建即默认保留：唯一删除途径是验证全等后的逐 entry
  // 删除协议（trash === null 表示已删尽或已换回原位；非 null 一律
  // 按保留语义留在原位，清理路径不做整树递归删除）
  let trash = null;
  try {
    try {
      execFileSync(DOCKER_CLI, [
        'cp', `${name}:${CONTAINER_OUTPUT_ROOT}/.`, `${staging}/`,
      ], {
        encoding: 'utf8',
        timeout: 60000,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      });
    } catch (error) {
      throw copyFailure(`docker cp 回拷失败: ${error.message}`);
    }
    const stagingIdentity = verifyStagingInternal(staging, preSnapshot);

    // 1. 装配：期望前态（含内容 sha256）+ 完整最终树（已有 entry 与
    // staging entry 一律 copyFileSync 全量字节拷贝，不用硬链接；
    // staging 按验证身份表逐 entry 重 lstat 绑定）
    assemble = mkdtempSync(join(dirname(outputRoot), '.assemble-'));
    const expected = walkTreeIdentity(outputRoot);
    assembleExistingTree(outputRoot, assemble, expected);
    callPublishHook('pre-assemble-staging', { staging });
    assembleStagingTree(staging, assemble, stagingIdentity);

    // 2. 换前复验：outputRoot 与 expected 全等（含内容摘要），宿主
    // 并发增删换或内容编辑即失败关闭（此阶段尚未触碰正式 outputRoot，
    // 零污染）
    callPublishHook('pre-swap-verify', { outputRoot, staging, assemble });
    const preSwapDiff = diffTreeIdentity(expected, walkTreeIdentity(outputRoot));
    if (preSwapDiff.length > 0) {
      throw unsafeContent(
        '换前复验：outputRoot 与装配基线不一致（宿主并发增删换或内容编辑）: ' +
        preSwapDiff.join('; '),
      );
    }

    // 3. 交换：两次 rename；第二 rename 失败立即换回原位
    trash = freshSiblingName(dirname(outputRoot), '.trash-');
    swapRenameSync(outputRoot, trash, 'first');
    try {
      swapRenameSync(assemble, outputRoot, 'second');
      assemble = null; // 已被改名到正式位置
    } catch (swapError) {
      let restoreError = null;
      try {
        renameSync(trash, outputRoot);
        trash = null;
      } catch (error) {
        restoreError = error;
      }
      if (restoreError === null) {
        const failure = copyFailure(
          `swap 第二 rename 失败，已换回原位: ${swapError.message}`);
        failure.rollbackState = { status: 'COMPLETE' };
        throw failure;
      }
      // 换回失败：trash 按默认保留语义留在原位并 PARTIAL 外传
      const failure = copyFailure(
        `swap 第二 rename 失败且换回失败: ${swapError.message}；` +
        `换回失败: ${restoreError.message}`);
      failure.rollbackState = {
        status: 'PARTIAL',
        errors: [`trash 保留在 ${trash}`, restoreError.message],
      };
      throw failure;
    }

    // 4. trash 处置：trash 一旦创建即默认保留，唯一删除途径是验证
    // 全等后的逐 entry 删除协议。复验/遍历/哈希任何异常 → 保留原位
    // + PARTIAL 明细外传；不做整树递归删除
    callPublishHook('pre-trash-verify', { outputRoot, trash });
    let trashDiff;
    try {
      trashDiff = diffTreeIdentity(expected, walkTreeIdentity(trash));
    } catch (trashVerifyError) {
      const failure = copyFailure(
        `trash 复验异常，trash 保留原位: ${trashVerifyError.message}`);
      failure.rollbackState = {
        status: 'PARTIAL',
        errors: [`trash 复验异常: ${trashVerifyError.message}`],
      };
      throw failure;
    }
    if (trashDiff.length > 0) {
      const failure = copyFailure(
        'trash 复验不一致（复验—交换窗口内宿主写入或内容编辑），' +
        `trash 保留原位: ${trashDiff.join('; ')}`);
      failure.rollbackState = {
        status: 'PARTIAL',
        errors: trashDiff.map(item => `trash:${item}`),
      };
      throw failure;
    }
    callPublishHook('pre-trash-delete', { trash });
    const deletion = deleteTrashEntries(trash, expected);
    if (deletion.errors.length > 0) {
      const failure = copyFailure(
        `trash 逐 entry 删除协议中止，剩余保留原位: ${deletion.errors.join('; ')}`);
      failure.rollbackState = {
        status: 'PARTIAL',
        errors: deletion.errors,
      };
      throw failure;
    }
    // 逐 entry 协议全部删尽（唯一清除点）
    trash = null;
    return { errorCode: null };
  } catch (error) {
    return {
      errorCode: error.code === 'RESOURCE_ISOLATION_UNSAFE'
        ? 'RESOURCE_ISOLATION_UNSAFE'
        : 'RESOURCE_CLEANUP_FAILED',
      detail: error.message,
      // 机器可读回滚状态（cp/验证/换前复验失败未进入 swap，无此字段）
      ...(error.rollbackState ? { rollback: error.rollbackState } : {}),
    };
  } finally {
    // 任何路径都删除 staging 与未安装的 assemble；trash 不做整树
    // 递归删除——唯一清除点是验证全等后的逐 entry 删除协议
    // （trash === null 表示已删尽或已换回原位；非 null 一律按默认
    // 保留语义留在原位）
    rmSync(staging, { recursive: true, force: true });
    if (assemble) {
      rmSync(assemble, { recursive: true, force: true });
    }
  }
}

// ─── lifecycle adapter ───

/**
 * 在 --network none 容器内启动 server（精确 node <project-relative.mjs>
 * <decimal-port> 形状；server 即容器 PID 1 主进程）。项目根只读挂载，
 * 不挂载任何宿主可写目录；cgroup --memory/--cpus/--memory-swap 取自
 * 配置的资源预算。容器启动后前置验证 memory.events 可机械读取，
 * 不可读（含 cgroup v1）即 docker rm -f 并失败关闭。
 * @param {{ command: object, cwd: string, env: object }} input
 * @returns {{ name: string, containerId: string, startedAt: number }}
 */
export function startDockerLifecycle({ command, cwd, env }) {
  const { image, resources } = requireConfigured();
  const { runner, invocation, args } = command || {};

  if (runner !== 'node') {
    throw new Error(`runner must be "node", got "${runner}"`);
  }
  if (invocation !== 'node') {
    throw new Error(`invocation must be "node", got "${invocation}"`);
  }
  if (!Array.isArray(args) || args.length !== 2) {
    throw new Error(`args must have exactly 2 elements [<relative.mjs>, <port>], got ${args?.length ?? 'non-array'}`);
  }
  const entry = args[0];
  const port = args[1];
  if (typeof entry !== 'string' || !entry.endsWith('.mjs') ||
      entry.includes('..') || entry.startsWith('/')) {
    throw new Error(`entry must be a relative .mjs path, got "${entry}"`);
  }
  if (typeof port !== 'string' || !/^\d+$/.test(port)) {
    throw new Error(`port must be a decimal number string, got "${port}"`);
  }
  for (const arg of args) {
    if (/[;&|`$(){}[\]!#~]/.test(arg)) {
      throw new Error(`arg contains shell metacharacters: "${arg}"`);
    }
  }

  // 用 realpathSync/relative 证明 .mjs 入口真实位于 cwd 内
  const resolvedCwd = realpathSync(cwd);
  const resolvedEntry = realpathSync(join(resolvedCwd, entry));
  const relFromCwd = relative(resolvedCwd, resolvedEntry);
  if (relFromCwd.startsWith('..') || relFromCwd.startsWith('/')) {
    throw new Error(`entry "${entry}" escapes cwd: resolved to "${relFromCwd}"`);
  }

  // 全部前置门禁（socket 扫描、daemon、镜像、cgroup v2）先于任何容器启动
  assertNoUnixSockets(resolvedCwd);
  const name = containerNameFromEnv(env);
  assertDockerDaemon();
  assertImagePresent(image);
  assertCgroupV2Daemon();

  const scratch = mkdtempSync(join(tmpdir(), 'e2e-docker-lifecycle-'));
  try {
    const outputRoot = realpathSync(ensureOutputRoot(env));
    const envFile = writeEnvFile(env, resolvedCwd, outputRoot, scratch);
    // 同名残留容器（同一 runId 的重试）先内核级清理
    if (containerExists(name)) {
      removeContainer(name);
    }
    const containerId = execFileSync(DOCKER_CLI, [
      'run', '-d',
      '--network', 'none',
      '--memory', `${resources.memMB}m`,
      '--memory-swap', `${resources.memMB}m`,
      '--cpus', String(resources.cpu),
      '--name', name,
      '--env-file', envFile,
      '-v', `${resolvedCwd}:${CONTAINER_WORK_ROOT}:ro`,
      '-w', CONTAINER_WORK_ROOT,
      image,
      'node', entry, port,
    ], {
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    }).trim();

    // 有界等待后确认容器仍在运行（server 立即退出即失败关闭）
    boundedWait(500);
    if (!containerRunning(name)) {
      removeContainer(name);
      throw new Error('lifecycle container exited prematurely');
    }

    // OOM 机械判定前置验证：memory.events 必须可读且含 oom_kill，
    // 不可用（含 cgroup v1）即清场并失败关闭，不进入执行
    if (readOomKillCount(name) === null) {
      removeContainer(name);
      const failure = new Error('lifecycle 容器 memory.events 不可机械读取，失败关闭');
      failure.code = 'RESOURCE_ISOLATION_UNSAFE';
      throw failure;
    }

    return { name, containerId, startedAt: Date.now() };
  } catch (error) {
    // 启动失败：内核级清理后抛错，不留残留容器
    try {
      removeContainer(name);
    } catch {}
    throw error;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * 停止 lifecycle 容器：docker rm -f 由内核终止容器内全部进程。
 * 容器已不存在视为已停止；删除后仍存在抛错。
 * @param {{ lifecycle: object, plan: object }} input
 */
export function stopDockerLifecycle({ lifecycle }) {
  if (!lifecycle?.name) return;
  removeContainer(lifecycle.name);
  if (containerExists(lifecycle.name)) {
    throw new Error(`container ${lifecycle.name} still exists after docker rm -f`);
  }
}

export const dockerLifecycleAdapter = {
  start: startDockerLifecycle,
  stop: stopDockerLifecycle,
};

// ─── readiness probe ───

const LOOPBACK_GET_SCRIPT = `
const http = require('node:http');
const req = http.get(process.argv[1], { timeout: 2500 }, (res) => {
  res.resume();
  res.on('end', () => {
    process.stdout.write(String(res.statusCode));
    process.exit(0);
  });
});
req.on('timeout', () => { req.destroy(); process.exit(1); });
req.on('error', () => process.exit(1));
`;

/**
 * 容器内 loopback readiness probe：docker exec node -e <HTTP GET>，
 * 只接受 expectedStatus。只接受 loopback HTTP URL；无 lifecycle 容器
 * 失败关闭。
 * @param {{ url: string, timeoutMs: number, expectedStatus: number }} readiness
 * @param {{ lifecycle: object|null }} ctx
 * @returns {{ status: number, ok: boolean, error?: string }}
 */
export function dockerReadinessProbe(readiness, ctx) {
  const { url, timeoutMs = 10000, expectedStatus = 200 } = readiness;
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return { status: 0, ok: false, error: `invalid URL: ${e.message}` };
  }
  if (parsed.protocol !== 'http:') {
    return { status: 0, ok: false, error: 'URL must use http: protocol' };
  }
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    return { status: 0, ok: false, error: 'URL must target loopback address' };
  }
  if (!ctx?.lifecycle?.name) {
    return { status: 0, ok: false, error: 'docker readiness 需要 lifecycle 容器' };
  }
  const name = ctx.lifecycle.name;

  while (Date.now() < deadline) {
    try {
      const result = execFileSync(DOCKER_CLI, [
        'exec', name, 'node', '-e', LOOPBACK_GET_SCRIPT, url,
      ], {
        encoding: 'utf8',
        timeout: 8000,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      });
      const status = Number(result.trim());
      if (status === expectedStatus) {
        return { status, ok: true };
      }
      lastError = new Error(`unexpected status ${status}`);
    } catch (error) {
      lastError = error;
    }
    boundedWait(200);
  }

  return { status: 0, ok: false, error: lastError?.message };
}

// ─── docker runner ───

/** 零副作用的失败返回形状。 */
function zeroSideEffectFailure(errorCode) {
  return {
    status: null,
    stdout: '',
    stderr: '',
    errorCode,
    resourceObservation: makeResourceObservation({ cpuPeak: 0, memPeakMB: 0, sampleCount: 0 }),
  };
}

/**
 * Docker runner：在 --network none 容器内真实执行命令并采样 cgroup 资源。
 *
 * 机械合同：
 * 1. outer 侧 RESOURCE_INVALID_BUDGET 前置验证与本机宿主 playwrightRunner
 *    同形同语义：context/resourceBudget/timeouts 缺失或畸形、
 *    options.timeout !== timeouts.total 一律零副作用返回；
 * 2. 全部前置门禁（Unix socket 扫描、daemon、镜像、cgroup v2）先于任何
 *    容器启动；socket 发现或 cgroup v1 → RESOURCE_ISOLATION_UNSAFE，
 *    零副作用；
 * 3. 项目根只读挂载，不挂载任何宿主可写目录；输出写容器可写层
 *    /e2e-output，执行成功（无 errorCode，含测试失败退出码）后
 *    docker cp 拷贝回宿主 output root 并做 symlink 安全门；
 *    OOM/timeout/异常路径维持 docker rm -f 清场不拷贝；
 * 4. 有同名 lifecycle 容器在运行时 docker exec 进入该容器（cgroup 上限在
 *    容器创建时施加，server 为 PID 1）；否则自建 idle init 容器
 *    （--memory/--memory-swap/--cpus 取自 context.resourceBudget）后
 *    docker exec 执行真实命令；
 * 5. OOM 机械判定全链失败关闭：容器启动后 memory.events 必须可读；
 *    exec 前 oom_kill 基线读取失败 → 不执行、RESOURCE_ISOLATION_UNSAFE；
 *    非零退出后复读失败 → 保守映射 RESOURCE_MEMORY_LIMIT；delta>0 →
 *    RESOURCE_MEMORY_LIMIT；.State.OOMKilled 保留为佐证；
 * 6. command/args/env 中 output root 前缀翻译为 /e2e-output、root 前缀
 *    翻译为 /work，注入 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright，
 *    PATH/HOME 不透传；
 * 7. 执行期间由独立采样器子进程轮询 docker stats --no-stream 记录
 *    cpuPeak/memPeakMB；宿主侧 spawnSync 超时映射 RESOURCE_TIMEOUT，
 *    maxBuffer 越界映射 RESOURCE_BUFFER_OVERFLOW。
 *
 * @param {string} command
 * @param {string[]} args
 * @param {object} options
 * @param {object} context
 * @returns {{ status: number|null, stdout: string, stderr: string, errorCode?: string, resourceObservation: object }}
 */
export function dockerRunner(command, args, options, context) {
  const timeoutMs = options?.timeout || 30000;
  const maxBuffer = options?.maxBuffer || 1024 * 1024;

  // 前置验证 context：缺失或畸形直接返回 RESOURCE_INVALID_BUDGET，目标零副作用
  if (!context || typeof context !== 'object') {
    return zeroSideEffectFailure('RESOURCE_INVALID_BUDGET');
  }
  const { resourceBudget, timeouts } = context;
  if (!resourceBudget || typeof resourceBudget !== 'object' ||
      !timeouts || typeof timeouts !== 'object') {
    return zeroSideEffectFailure('RESOURCE_INVALID_BUDGET');
  }
  if (typeof resourceBudget.cpu !== 'number' ||
      !Number.isFinite(resourceBudget.cpu) || resourceBudget.cpu <= 0 ||
      !Number.isInteger(resourceBudget.memMB) || resourceBudget.memMB < 128) {
    return zeroSideEffectFailure('RESOURCE_INVALID_BUDGET');
  }
  if (!Number.isInteger(timeouts.total) || timeouts.total <= 0 ||
      timeouts.total !== timeoutMs) {
    return zeroSideEffectFailure('RESOURCE_INVALID_BUDGET');
  }
  if (typeof command !== 'string' || command.length === 0 ||
      !Array.isArray(args) || args.some(arg => typeof arg !== 'string')) {
    return zeroSideEffectFailure('RESOURCE_INVALID_BUDGET');
  }

  // 全部前置门禁先于任何容器启动：socket 扫描与 cgroup v1 拒绝
  // 均为零副作用返回
  const root = realpathSync(options.cwd || process.cwd());
  try {
    assertNoUnixSockets(root);
    assertCgroupV2Daemon();
  } catch (error) {
    return zeroSideEffectFailure(error.code || 'RESOURCE_ISOLATION_UNSAFE');
  }

  // daemon/镜像在任何容器副作用前确认（errorCode 经抛出传递，
  // M5 既有 runner 异常路径承接）
  const { image } = requireConfigured();
  assertDockerDaemon();
  assertImagePresent(image);

  const name = containerNameFromEnv(options.env);
  // output root realpath 归一（/var → /private/var 等 symlink 漂移）；
  // 不再挂载进容器，仅作为成功路径 docker cp 的宿主目标
  const outputRoot = realpathSync(ensureOutputRoot(options.env));
  // 执行前快照：回拷验证的覆盖保护基线（文件不得覆盖执行前制品）
  const preSnapshot = snapshotOutputRoot(outputRoot);
  const scratch = mkdtempSync(join(tmpdir(), 'e2e-docker-run-'));
  let samplerControl = null;
  // 自建容器时由本函数负责 docker rm -f；exec 进入 lifecycle 容器时
  // 只在 timeout/OOM/异常路径 rm -f
  let ownContainer = false;

  try {
    const envFile = writeEnvFile(options.env, root, outputRoot, scratch);
    // runtime config（M5 内部固定生成形状）结构化翻译到临时副本，
    // 宿主原件不被修改；副本经 docker cp 进入容器 /e2e-run/
    let containerConfigArg = null;
    if (typeof context.runtimeConfig === 'string' &&
        existsSync(context.runtimeConfig)) {
      const resolvedConfig = realpathSync(context.runtimeConfig);
      if (resolvedConfig.startsWith(`${root}/`)) {
        const configCopy = translateRuntimeConfigToCopy(
          resolvedConfig, root, outputRoot, scratch);
        containerConfigArg = { hostCopy: configCopy, resolvedConfig };
      }
    }
    const translateArg = arg =>
      containerConfigArg && arg === containerConfigArg.resolvedConfig
        ? CONTAINER_CONFIG_PATH
        : translateExecPath(arg, root, outputRoot);
    const translatedCommand = translateExecPath(command, root, outputRoot);
    const translatedArgs = args.map(translateArg);

    if (!containerRunning(name)) {
      // 无 lifecycle 容器：自建 idle init 容器，cgroup 上限取自预算；
      // idle init 只占住容器，真实命令经 docker exec 进入，使 exec 进程
      // 被 cgroup OOM 杀死时容器仍存活、memory.events 可机械复读
      if (containerExists(name)) {
        removeContainer(name);
      }
      ownContainer = true;
      execFileSync(DOCKER_CLI, [
        'run', '-d',
        '--network', 'none',
        '--memory', `${resourceBudget.memMB}m`,
        '--memory-swap', `${resourceBudget.memMB}m`,
        '--cpus', String(resourceBudget.cpu),
        '--name', name,
        '-v', `${root}:${CONTAINER_WORK_ROOT}:ro`,
        '-w', CONTAINER_WORK_ROOT,
        image,
        'node', '-e', IDLE_INIT_SCRIPT,
      ], {
        encoding: 'utf8',
        timeout: 30000,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      });
      boundedWait(300);
      if (!containerRunning(name)) {
        throw new Error('dockerRunner: idle init container exited prematurely');
      }
    }

    // OOM 机械判定基线：cgroup v2 memory.events 的 oom_kill 计数。
    // 基线读取失败 → 不执行，失败关闭（含容器 memory.events 不可读的
    // 前置验证），宁不执行也不失证据
    const oomBaseline = readOomKillCount(name);
    if (oomBaseline === null) {
      removeContainer(name);
      return {
        status: null,
        stdout: '',
        stderr: '',
        errorCode: 'RESOURCE_ISOLATION_UNSAFE',
        resourceObservation: makeResourceObservation({ cpuPeak: 0, memPeakMB: 0, sampleCount: 0 }),
      };
    }

    // 容器可写层准备输出根与 config 副本（不挂载任何宿主可写目录）。
    // /e2e-run/node_modules → /work/node_modules 符号链接让 config 副本的
    // ESM import（如 @playwright/test）能按父目录查找解析到 ro 挂载内的
    // 项目依赖；链接位于容器可写层，不进入 docker cp 拷贝面
    execFileSync(DOCKER_CLI, [
      'exec', name, 'mkdir', '-p', CONTAINER_OUTPUT_ROOT, '/e2e-run',
    ], {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    execFileSync(DOCKER_CLI, [
      'exec', name, 'ln', '-sfn', `${CONTAINER_WORK_ROOT}/node_modules`,
      '/e2e-run/node_modules',
    ], {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    if (containerConfigArg) {
      execFileSync(DOCKER_CLI, [
        'cp', containerConfigArg.hostCopy, `${name}:${CONTAINER_CONFIG_PATH}`,
      ], {
        encoding: 'utf8',
        timeout: 30000,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      });
    }

    samplerControl = startStatsSampler(name, scratch);
    const result = spawnSync(DOCKER_CLI, [
      'exec',
      '--env-file', envFile,
      '-w', CONTAINER_WORK_ROOT,
      name,
      translatedCommand,
      ...translatedArgs,
    ], {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    const peaks = samplerControl.cleanup();
    samplerControl = null;
    const resourceObservation = makeResourceObservation(peaks);

    // 宿主侧超时：docker rm -f 内核级终止容器内全部进程，不拷贝输出
    if (result.error && result.error.code === 'ETIMEDOUT') {
      removeContainer(name);
      return {
        status: null,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        errorCode: 'RESOURCE_TIMEOUT',
        resourceObservation,
      };
    }
    if (result.error && result.error.code === 'ENOBUFS') {
      removeContainer(name);
      return {
        status: result.status ?? null,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        errorCode: 'RESOURCE_BUFFER_OVERFLOW',
        resourceObservation,
      };
    }
    if (result.error) {
      throw new Error(`dockerRunner: spawnSync failed: ${result.error.message}`);
    }

    // OOM 机械判定：memory.events oom_kill delta>0 即 exec 进程被 cgroup
    // OOM 杀死；非零退出后复读失败 → 保守映射 RESOURCE_MEMORY_LIMIT
    // （宁枉勿纵），两条路径都 docker rm -f 清场不拷贝；
    // .State.OOMKilled 保留为佐证而非唯一证据
    if (result.status !== 0) {
      const oomAfter = readOomKillCount(name);
      if (oomAfter === null || oomAfter > oomBaseline) {
        removeContainer(name);
        return {
          status: result.status,
          stdout: result.stdout || '',
          stderr: result.stderr || '',
          errorCode: 'RESOURCE_MEMORY_LIMIT',
          resourceObservation,
        };
      }
    }
    if (containerOomKilled(name)) {
      removeContainer(name);
      return {
        status: result.status,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        errorCode: 'RESOURCE_MEMORY_LIMIT',
        resourceObservation,
      };
    }

    // 成功路径（无 errorCode，含测试失败退出码）：docker cp 回拷为
    // staging + 递归 lstat 验证 + assemble-verify-swap 批次原子发布，
    // M5 外部语义与既有宿主路径一致；不可信内容（类型/硬链接/超限/
    // 冲突/换前复验宿主并发增删换）→ RESOURCE_ISOLATION_UNSAFE，
    // cp/IO/swap/trash 复验失败 → RESOURCE_CLEANUP_FAILED；两条失败
    // 路径都 docker rm -f（维持 R5/R6 既有语义），staging 与未安装
    // assemble 删除；cp/验证/换前复验失败正式 output root 零污染，
    // swap 失败换回原位，trash 复验不等时 trash 保留并经返回结果
    // rollback 字段如实外传（M5 对外 errorCode 语义不变）
    const published = publishContainerOutput(name, outputRoot, preSnapshot);
    if (published.errorCode) {
      try {
        removeContainer(name);
      } catch {}
      return {
        status: result.status,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        errorCode: published.errorCode,
        // 机器可读回滚状态：COMPLETE = 正式目录已恢复执行前状态；
        // PARTIAL = 回滚部分/全部失败，正式目录可能残留（附 errors 摘要）；
        // 字段缺失 = 未进入发布阶段（cp/验证失败，零污染）
        ...(published.rollback ? { rollback: published.rollback } : {}),
        resourceObservation,
      };
    }

    if (ownContainer) {
      removeContainer(name);
    }
    return {
      status: result.status,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      resourceObservation,
    };
  } catch (error) {
    // 异常路径：内核级清理后重抛，不做输出拷贝
    try {
      if (samplerControl) samplerControl.cleanup();
    } catch {}
    try {
      if (containerExists(name)) removeContainer(name);
    } catch {}
    throw error;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ─── browser version probe ───

/**
 * 机械探测冻结镜像内 headless shell 的真实浏览器版本。
 * 只支持 channel playwright；channel chrome 抛错（docker 执行器不支持
 * system Chrome）。镜像必须预先存在，禁止拉取。与其他路径一样，全部
 * 前置门禁（socket 扫描、daemon、镜像、cgroup v2）先于容器启动，
 * docker run 带固定小额 --memory/--memory-swap/--cpus 硬资源参数。
 * @param {{ engine: string, channel: string }} browser
 * @param {{ cwd?: string }} ctx
 * @returns {{ version: string, executablePath: string }}
 */
export function dockerBrowserVersionProbe(browser, ctx = {}) {
  if (!browser || browser.engine !== 'chromium') {
    throw new Error(`dockerBrowserVersionProbe: unsupported engine "${browser?.engine}"`);
  }
  if (browser.channel === 'chrome') {
    throw new Error('dockerBrowserVersionProbe: docker 执行器不支持 system Chrome channel');
  }
  if (browser.channel !== 'playwright') {
    throw new Error(`dockerBrowserVersionProbe: unsupported channel "${browser.channel}"`);
  }
  // 门禁顺序：socket 扫描与 cgroup v2 验证先于 docker run
  assertNoUnixSockets(realpathSync(ctx.cwd || process.cwd()));
  const { image } = requireConfigured();
  assertDockerDaemon();
  assertImagePresent(image);
  assertCgroupV2Daemon();

  let output;
  try {
    output = execFileSync(DOCKER_CLI, [
      'run', '--rm', '--network', 'none',
      '--memory', `${VERSION_PROBE_MEMORY_MB}m`,
      '--memory-swap', `${VERSION_PROBE_MEMORY_MB}m`,
      '--cpus', String(VERSION_PROBE_CPUS),
      image, HEADLESS_SHELL_PATH, '--version',
    ], {
      encoding: 'utf8',
      timeout: 60000,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
  } catch (error) {
    throw new Error(`dockerBrowserVersionProbe: headless_shell --version 失败: ${error.message}`);
  }
  const match = output.match(BROWSER_VERSION_RE);
  if (!match) {
    throw new Error(`dockerBrowserVersionProbe: 不可解析的 --version 输出: ${JSON.stringify(output)}`);
  }
  return {
    version: match[1],
    executablePath: `docker:${HEADLESS_SHELL_PATH}`,
  };
}

// ─── resource observer ───

/**
 * 资源观测：只接受 docker-cgroup+stats observation。
 * mechanism 前缀必须匹配、sampleCount 为非负整数、两个峰值为有限非负数；
 * 否则抛错。不得重采样、补值或回退。
 * @param {{ run: object }} ctx
 * @returns {object} resourceObservation
 */
export function dockerResourceObserver(ctx) {
  const { run } = ctx || {};
  if (!run || typeof run !== 'object') {
    throw new Error('dockerResourceObserver: run object is required');
  }
  const obs = run.resourceObservation;
  if (!obs || typeof obs !== 'object') {
    throw new Error('dockerResourceObserver: resourceObservation not found on run');
  }
  if (typeof obs.mechanism !== 'string' ||
      !obs.mechanism.startsWith('docker-cgroup+stats:')) {
    throw new Error(`dockerResourceObserver: unexpected mechanism: ${obs.mechanism}`);
  }
  if (!Number.isInteger(obs.sampleCount) || obs.sampleCount < 0) {
    throw new Error(`dockerResourceObserver: sampleCount 必须是非负整数, got ${obs.sampleCount}`);
  }
  if (typeof obs.cpuPeak !== 'number' || !Number.isFinite(obs.cpuPeak) ||
      obs.cpuPeak < 0) {
    throw new Error(`dockerResourceObserver: cpuPeak 必须是有限非负数, got ${obs.cpuPeak}`);
  }
  if (typeof obs.memPeakMB !== 'number' || !Number.isFinite(obs.memPeakMB) ||
      obs.memPeakMB < 0) {
    throw new Error(`dockerResourceObserver: memPeakMB 必须是有限非负数, got ${obs.memPeakMB}`);
  }
  return obs;
}

// ─── teardown inspector ───

/**
 * teardown 检查：容器不存在即 stopped/freed；任何同名残留容器即未清理。
 * 端口从宿主侧 lsof 观察（--network none 容器无法绑定宿主端口）。
 * 只观察，不删容器。
 * @param {{ plan: object, runId: string, run: object|null, outputRoot: string, lifecycle: object|null, phase?: string }} ctx
 * @returns {{ processes: Array, ports: Array }}
 */
export function dockerTeardownInspector(ctx) {
  const { lifecycle, plan, runId } = ctx;
  const processes = [];
  const ports = [];

  const name = typeof runId === 'string' && CONTAINER_NAME_RE.test(runId)
    ? runId
    : lifecycle?.name;
  if (name) {
    if (containerExists(name)) {
      let pid = 0;
      try {
        const output = execFileSync(DOCKER_CLI, [
          'inspect', '--format', '{{.State.Pid}}', name,
        ], {
          encoding: 'utf8',
          timeout: 15000,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
        });
        const parsed = Number(output.trim());
        if (Number.isInteger(parsed) && parsed > 0) pid = parsed;
      } catch {}
      processes.push({
        pid,
        kind: 'docker-container',
        started: true,
        stopped: false,
      });
    } else if (lifecycle?.name) {
      processes.push({
        pid: 0,
        kind: 'docker-container',
        started: true,
        stopped: true,
      });
    }
  }

  // 检查 server 端口在宿主侧是否释放
  if (!plan?.baseURL) {
    throw new Error('plan.baseURL is required for teardown inspection');
  }
  let url;
  try {
    url = new URL(plan.baseURL);
  } catch (e) {
    throw new Error(`invalid plan.baseURL: ${e.message}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`plan.baseURL must use http: or https: protocol, got ${url.protocol}`);
  }
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  if (!port || port < 1 || port > 65535) {
    throw new Error(`invalid port in plan.baseURL: ${port}`);
  }

  try {
    const result = execFileSync('/usr/sbin/lsof', [
      '-nP',
      `-iTCP:${port}`,
      '-sTCP:LISTEN',
      '-t',
    ], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    ports.push({ port, freed: result.trim().length === 0 });
  } catch (e) {
    // 只有 status 1 且 stdout/stderr 都为空才表示 freed
    if (e.status === 1 || e.code === 1) {
      const stdout = e.stdout?.toString()?.trim() ?? '';
      const stderr = e.stderr?.toString()?.trim() ?? '';
      if (stdout === '' && stderr === '') {
        ports.push({ port, freed: true });
      } else {
        throw new Error(`lsof exited with status 1 but had output: stdout="${stdout}", stderr="${stderr}"`);
      }
    } else {
      throw new Error(`failed to check port ${port}: ${e.message}`);
    }
  }

  return { processes, ports };
}
