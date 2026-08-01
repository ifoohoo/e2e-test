/**
 * 受信执行宿主适配器：真实 Chromium + loopback server lifecycle。
 *
 * 提供 readinessProbe、networkObserver、resourceObserver、teardownInspector、
 * browserVersionProbe 和 lifecycleAdapter，供 createBrowserExecutionController
 * 消费。所有观测值来自真实进程和网络状态，不硬编码。
 *
 * Attempt 004c：进程组状态机 TERM→poll→KILL→poll，使用 /bin/ps 完整 pgid 成员快照。
 * lifecycle/readiness/teardown 严格使用真实进程和端口状态。
 *
 * Attempt 003：移除已被 VALID/REJECT 审计否决的 sandbox-exec 包装（Node 3.1
 * 保持 blocked，网络性质由 networkObserver 举证，OS 级隔离留待外部执行器）；
 * startLifecycle 保留 lsof 端口只监听 loopback 的验证。
 *
 * 机械边界：无 execSync、无 shell string、shell:false；
 * readiness 只接受 loopback HTTP URL；
 * start 只接受精确 node <project-relative.mjs> <decimal-port> 形状；
 * stop 向 -pgid 发 TERM，轮询完整成员快照；超时向 -pgid 发 KILL，再有界轮询；
 * inspector 只观察，不杀进程。
 * 进程组判定：/bin/ps -axo pid=,pgid=,stat= 全量快照，Z 视为已退出。
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// ─── 内部辅助：进程组跟踪 ───

/** @type {Map<number, number>} pid → pgid */
const processGroups = new Map();

/**
 * 用绝对 /bin/ps 读取 pid=,pgid=,stat= 的全进程快照，
 * 返回 pgid === targetPgid 的成员 [{pid, stat}]。
 *
 * ps 缺失、退出非 0、畸形行或解析不明确时抛错，不回退。
 * @param {number} targetPgid
 * @returns {{pid: number, stat: string}[]}
 */
function queryPgidMembers(targetPgid) {
  if (!Number.isInteger(targetPgid) || targetPgid <= 0) {
    throw new Error(`queryPgidMembers: invalid pgid ${targetPgid}`);
  }
  let output;
  try {
    output = execFileSync('/bin/ps', [
      '-axo', 'pid=,pgid=,stat=',
    ], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new Error(`queryPgidMembers: /bin/ps failed (exit ${error.status}): ${error.message}`);
  }

  const members = [];
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 3) {
      throw new Error(`queryPgidMembers: malformed ps line: ${JSON.stringify(line)}`);
    }
    const pid = Number(parts[0]);
    const pgid = Number(parts[1]);
    const stat = parts[2];
    if (!Number.isInteger(pid) || pid <= 0 ||
        !Number.isInteger(pgid) || pgid <= 0 ||
        !stat) {
      throw new Error(`queryPgidMembers: unparseable ps line: ${JSON.stringify(line)}`);
    }
    if (pgid === targetPgid) {
      members.push({ pid, stat });
    }
  }
  return members;
}

/**
 * 进程组是否有任何非 zombie 成员仍然存活。
 * @param {number} pgid
 * @returns {boolean}
 */
function groupMembersAlive(pgid) {
  return queryPgidMembers(pgid).some(member => !member.stat.startsWith('Z'));
}

/**
 * 向 -pgid 发送信号。ESRCH 表示进程组不存在，返回 false。
 * @param {number} pgid
 * @param {string} signal
 * @returns {boolean}
 */
function signalGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

/**
 * 等待进程组从内核消失。
 * 优先用 groupMembersAlive（ps 快照）检测 zombie，再确认 ESRCH。
 * @param {number} pgid
 * @param {number} timeoutMs
 * @returns {boolean} true = 进程组已停止
 */
function waitForGroupStop(pgid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!groupMembersAlive(pgid)) return true;
    boundedWait(100);
  }
  return !groupMembersAlive(pgid);
}

/**
 * 同步有界等待，使用 Atomics.wait，不得派生 Node sleep 子进程。
 * @param {number} ms 等待毫秒数
 */
function boundedWait(ms) {
  const sab = new SharedArrayBuffer(4);
  const int32 = new Int32Array(sab);
  Atomics.wait(int32, 0, 0, ms);
}

// ─── readiness probe ───

/**
 * HTTP GET readiness probe，带超时和重试。
 * 只接受 loopback HTTP URL，真实读取状态。
 * 使用 /usr/bin/curl 参数数组。
 * @param {{ url: string, timeoutMs: number, expectedStatus: number }} readiness
 * @param {{ lifecycle: object|null }} ctx
 * @returns {{ status: number, ok: boolean }}
 */
export function readinessProbe(readiness, ctx) {
  const { url, timeoutMs = 10000, expectedStatus = 200 } = readiness;
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  // 验证 URL 是有效的 loopback HTTP URL
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

  while (Date.now() < deadline) {
    // 使用 /usr/bin/curl 参数数组，绝对路径
    try {
      const result = execFileSync('/usr/bin/curl', [
        '-s', '-o', '/dev/null',
        '-w', '%{http_code}',
        '--max-time', '3',
        url,
      ], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const status = Number(result.trim().replace(/"/g, ''));
      if (status === expectedStatus) {
        return { status, ok: true };
      }
      lastError = new Error(`unexpected status ${status}`);
    } catch (error) {
      lastError = error;
    }

    // 同步有界等待 200ms
    boundedWait(200);
  }

  return { status: 0, ok: false, error: lastError?.message };
}

// ─── lifecycle adapter ───

/**
 * 启动 server 进程（如 `node <project-relative.mjs> <decimal-port>`）。
 * 只接受精确 `node node <project-relative.mjs> <decimal-port>` 形状，
 * 使用 process.execPath、项目 containment、detached:true、stdio:"ignore"。
 * @param {{ command: object, cwd: string, env: object }} input
 * @returns {{ pid: number, pgid: number, startedAt: number }}
 */
export function startLifecycle({ command, cwd, env }) {
  const { runner, invocation, args } = command;

  // 校验 runner === "node"
  if (runner !== 'node') {
    throw new Error(`runner must be "node", got "${runner}"`);
  }

  // 校验 invocation === "node"
  if (invocation !== 'node') {
    throw new Error(`invocation must be "node", got "${invocation}"`);
  }

  // 校验 args.length === 2
  if (!Array.isArray(args) || args.length !== 2) {
    throw new Error(`args must have exactly 2 elements [<relative.mjs>, <port>], got ${args?.length ?? 'non-array'}`);
  }

  const entry = args[0];
  const port = args[1];

  // 入口必须是相对 .mjs 路径
  if (typeof entry !== 'string' || !entry.endsWith('.mjs') || entry.includes('..') || entry.startsWith('/')) {
    throw new Error(`entry must be a relative .mjs path, got "${entry}"`);
  }

  // 端口必须是十进制数字
  if (typeof port !== 'string' || !/^\d+$/.test(port)) {
    throw new Error(`port must be a decimal number string, got "${port}"`);
  }

  // 验证没有注入攻击：args 中不允许 shell 元字符
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

  // 直接以独立进程组启动 server；网络性质由 networkObserver 举证，
  // 绑定地址由下方 verifyPortLoopbackOnly 机械验证（OS 级隔离属 Node 3.1，
  // 当前 blocked，等待外部执行器方案）。
  const child = spawn(process.execPath, [entry, port], {
    cwd: resolvedCwd,
    env: { ...env },
    stdio: 'ignore',
    shell: false,
    detached: true, // 创建新进程组
  });

  const handle = {
    pid: child.pid,
    pgid: child.pid, // detached:true 时 pgid = pid
    startedAt: Date.now(),
  };

  // 记录 pid → pgid
  processGroups.set(child.pid, child.pid);
  // 同步有界等待 500ms 检查进程是否立即退出
  boundedWait(500);

  // 用完整 pgid 快照确认至少有一个非 zombie 成员
  if (!groupMembersAlive(child.pid)) {
    processGroups.delete(child.pid);
    throw new Error('lifecycle process exited prematurely');
  }

  // 验证端口只监听 loopback（从实际进程组确认）
  try {
    verifyPortLoopbackOnly(Number(port), child.pid);
  } catch (error) {
    // 验证失败：清理进程组后抛错
    try {
      signalGroup(child.pid, 'SIGTERM');
      boundedWait(250);
      signalGroup(child.pid, 'SIGKILL');
      waitForGroupStop(child.pid, 5000);
    } catch {}
    processGroups.delete(child.pid);
    throw new Error(`lifecycle port verification failed: ${error.message}`);
  }

  return handle;
}

/**
 * 验证端口只监听 loopback 地址。
 * 使用 lsof 检查绑定地址，如果发现 wildcard 或非 loopback 绑定则失败关闭。
 *
 * 注意：lsof 只约束 server 绑定地址，不能阻止主动外连（审计 HYP-02）；
 * OS 级 loopback-only 隔离是 Node 3.1 的未决范围。
 *
 * @param {number} port 目标端口
 * @param {number} pgid 进程组 ID（用于关联验证）
 */
function verifyPortLoopbackOnly(port, pgid) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port: ${port}`);
  }

  // 等待 server 开始监听（最多 3 秒）
  const deadline = Date.now() + 3000;
  let lsofOutput = null;

  while (Date.now() < deadline) {
    try {
      lsofOutput = execFileSync('/usr/sbin/lsof', [
        '-nP',
        `-iTCP:${port}`,
        '-sTCP:LISTEN',
      ], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      break;
    } catch (error) {
      // lsof 返回 status 1 表示没有匹配，继续等待
      if (error.status === 1 || error.code === 1) {
        boundedWait(100);
        continue;
      }
      throw new Error(`lsof failed: ${error.message}`);
    }
  }

  if (!lsofOutput) {
    throw new Error(`port ${port} not listening after 3 seconds`);
  }

  // 解析 lsof 输出
  // 格式: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
  const lines = lsofOutput.trim().split('\n');
  let foundMatchingProcess = false;

  for (const line of lines) {
    // 跳过标题行
    if (line.startsWith('COMMAND')) continue;

    const parts = line.split(/\s+/);
    if (parts.length < 9) continue;

    const pid = Number(parts[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;

    // 检查是否是目标进程组的成员
    try {
      const members = queryPgidMembers(pgid);
      if (!members.some(m => m.pid === pid)) continue;
    } catch {
      continue;
    }

    foundMatchingProcess = true;

    // NAME 列格式: address:port (LISTEN)
    const nameStr = parts[parts.length - 2]; //倒数第二列是 address:port
    if (!nameStr) continue;

    // 检查是否是 wildcard 绑定
    if (nameStr.startsWith('*:') || nameStr.startsWith('0.0.0.0:') ||
        nameStr === '*:*' || nameStr.startsWith('[::]:')) {
      throw new Error(`port ${port} bound to wildcard address: ${nameStr}`);
    }

    // 检查是否是 loopback（127.0.0.1 或 ::1）
    const isIPv4Loopback = nameStr.startsWith('127.0.0.1:');
    const isIPv6Loopback = nameStr.startsWith('[::1]:') || nameStr.startsWith('[::1].');

    if (!isIPv4Loopback && !isIPv6Loopback) {
      throw new Error(`port ${port} bound to non-loopback address: ${nameStr}`);
    }
  }

  if (!foundMatchingProcess) {
    throw new Error(`no process from pgid ${pgid} found listening on port ${port}`);
  }
}

/**
 * 停止 lifecycle 进程。状态机：TERM→poll→KILL→poll。
 *
 * @param {{ pid: number, pgid: number, startedAt: number }} lifecycle
 * @param {object} plan
 */
export function stopLifecycle({ lifecycle, plan }) {
  if (!lifecycle?.pid) return;

  const pgid = lifecycle.pgid;
  const trackedPgid = processGroups.get(lifecycle.pid);
  if (trackedPgid !== pgid) {
    throw new Error(`stopLifecycle: lifecycle pgid ${pgid} does not match tracked pgid ${trackedPgid}`);
  }

  // 阶段 1：SIGTERM
  signalGroup(pgid, 'SIGTERM');

  // 阶段 2：等待进程组停止
  if (waitForGroupStop(pgid, 5000)) {
    processGroups.delete(lifecycle.pid);
    return;
  }

  // 阶段 3：SIGKILL
  signalGroup(pgid, 'SIGKILL');

  // 阶段 4：等待进程组停止
  if (!waitForGroupStop(pgid, 5000)) {
    throw new Error(`process group ${pgid} still alive after SIGKILL`);
  }

  processGroups.delete(lifecycle.pid);
}

export const lifecycleAdapter = {
  start: startLifecycle,
  stop: stopLifecycle,
};

// ─── browser version probe ───

const CHROME_CHANNEL_CANDIDATES = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'],
};

const BROWSER_VERSION_RE = /(\d+\.\d+\.\d+\.\d+)/;

/**
 * 以 `<executable> --version` 机械读取真实浏览器版本。
 * 只解析 X.Y.Z.W 形状，输出不可解析时抛错。
 * @param {string} executablePath
 * @returns {string}
 */
function readBrowserVersion(executablePath) {
  let output;
  try {
    output = execFileSync(executablePath, ['--version'], {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
  } catch (error) {
    throw new Error(
      `readBrowserVersion: "${executablePath} --version" failed: ${error.message}`,
    );
  }
  const match = output.match(BROWSER_VERSION_RE);
  if (!match) {
    throw new Error(
      `readBrowserVersion: unparseable --version output from ${executablePath}: ${JSON.stringify(output)}`,
    );
  }
  return match[1];
}

/**
 * 机械探测冻结计划所选 channel 的真实浏览器版本。
 *
 * - channel 'chrome'：在本机固定候选路径找 system Chrome，缺失抛错；
 * - channel 'playwright'：用项目自身安装的 playwright-core 解析 Chromium
 *   可执行文件路径，验证其真实存在后读取版本；playwright-core 缺失或
 *   浏览器未安装均抛错。任何路径都不触发下载。
 *
 * @param {{ engine: string, channel: string }} browser
 * @param {{ cwd?: string }} ctx
 * @returns {{ version: string, executablePath: string }}
 */
export function browserVersionProbe(browser, ctx = {}) {
  if (!browser || browser.engine !== 'chromium') {
    throw new Error(
      `browserVersionProbe: unsupported engine "${browser?.engine}"`,
    );
  }
  const cwd = ctx.cwd || process.cwd();

  if (browser.channel === 'chrome') {
    const candidates = CHROME_CHANNEL_CANDIDATES[process.platform] || [];
    const found = candidates.find(candidate => {
      try {
        return lstatSync(candidate).isFile();
      } catch {
        return false;
      }
    });
    if (!found) {
      throw new Error(
        `browserVersionProbe: system Chrome not found on platform "${process.platform}"`,
      );
    }
    return { version: readBrowserVersion(found), executablePath: found };
  }

  if (browser.channel === 'playwright') {
    // 用项目自身 playwright-core 解析可执行文件路径（只计算路径，不下载）
    const resolverScript =
      "const p=require('playwright-core');" +
      'process.stdout.write(p.chromium.executablePath());';
    let executablePath;
    try {
      executablePath = execFileSync(process.execPath, ['-e', resolverScript], {
        cwd,
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        env: { PATH: process.env.PATH || '' },
      }).trim();
    } catch (error) {
      throw new Error(
        `browserVersionProbe: playwright-core executablePath resolution failed: ${error.message}`,
      );
    }
    if (!executablePath) {
      throw new Error(
        'browserVersionProbe: playwright-core returned empty executablePath',
      );
    }
    let stat;
    try {
      stat = lstatSync(executablePath);
    } catch {
      throw new Error(
        `browserVersionProbe: playwright chromium executable missing: ${executablePath}`,
      );
    }
    if (!stat.isFile()) {
      throw new Error(
        `browserVersionProbe: playwright chromium path is not a file: ${executablePath}`,
      );
    }
    return {
      version: readBrowserVersion(executablePath),
      executablePath,
    };
  }

  throw new Error(
    `browserVersionProbe: unsupported channel "${browser.channel}"`,
  );
}

// ─── network observer ───

/**
 * networkObserver 包装层异常码（稳定枚举）：controller 侧
 * M5_NETWORK_OBSERVER_FAILED 的 violations 追加依赖 code 外传，
 * 使 trace 缺失、归档异常、内容异常、零 resource entry 可区分。
 */
const TRACE_ERROR_CODES = Object.freeze({
  OUTPUT_ROOT_INVALID: 'TRACE_OUTPUT_ROOT_INVALID',
  MISSING: 'TRACE_MISSING',
  ARCHIVE_INVALID: 'TRACE_ARCHIVE_INVALID',
  CONTENT_INVALID: 'TRACE_CONTENT_INVALID',
  EMPTY: 'TRACE_EMPTY',
});

/** 五枚举精确集合：顶层兜底的「已结构化」判定只用成员判断，不用前缀。 */
const TRACE_ERROR_CODE_SET = new Set(Object.values(TRACE_ERROR_CODES));

/**
 * 构造包装层结构化异常：稳定枚举 code + cause（原始异常），
 * message 保留可读摘要。
 */
function observerError(code, message, cause) {
  const failure = cause !== undefined
    ? new Error(message, { cause })
    : new Error(message);
  failure.code = code;
  return failure;
}

/**
 * 顶层兜底重包：code 已是 TRACE_ERROR_CODES 五枚举精确成员的异常
 * 原样传递；其余（EACCES/ENOENT/非枚举 TRACE_* 等底层异常）统一
 * 归入 TRACE_OUTPUT_ROOT_INVALID 并附 cause，保证任何非枚举 code
 * 不外泄。导出仅供测试验证精确集合判定。
 */
function rewrapObserverError(error) {
  if (error?.code && TRACE_ERROR_CODE_SET.has(error.code)) {
    return error;
  }
  return observerError(
    TRACE_ERROR_CODES.OUTPUT_ROOT_INVALID,
    `networkObserver: 底层异常: ${error?.message || String(error)}`,
    error,
  );
}

export { rewrapObserverError };

/**
 * 网络观测：从真实 Playwright trace.network 投影原始 URL。
 *
 * 机械合同：
 * 1. outputRoot 必须真实存在、为目录、不是 symlink；
 * 2. 用 Node readdirSync/lstatSync/realpathSync 安全递归；
 * 3. 按项目相对路径字典序处理所有真实 regular trace.zip；
 * 4. 只用绝对 /usr/bin/unzip 参数数组；
 * 5. 每个非空行必须是合法 JSON；只投影 type:"resource-snapshot" 的 snapshot.request.url；
 * 6. resource entry 缺 URL、URL 不是可解析绝对 URL 时抛错；
 * 7. 全部 trace 没有 resource entry 时抛错；
 * 8. 返回 {url, hop}，hop 按排序后的真实 entry 从 0 连续编号。
 * 所有抛错携带 TRACE_ERROR_CODES 稳定枚举 code；包装底层调用
 * （unzip、JSON.parse、URL 解析、fs 遍历/校验等）的异常另附 cause
 * （原始异常）；函数顶层兜底保证任何非 TRACE_* code（EACCES/
 * ENOENT 等底层 fs 异常）不外泄。
 *
 * @param {{ outputRoot: string }} ctx
 * @returns {{ url: string, hop: number }[]}
 */
export function networkObserver(ctx) {
  try {
    return networkObserverInner(ctx);
  } catch (error) {
    // 顶层兜底：按五枚举精确集合判定，任何非枚举 code（EACCES/
    // ENOENT/非枚举 TRACE_* 等底层异常）不外泄
    throw rewrapObserverError(error);
  }
}

function networkObserverInner(ctx) {
  const { outputRoot } = ctx;

  // 1. outputRoot 存在性判定用 lstatSync（不用 existsSync——后者在
  // 路径搜索阶段吞掉 EACCES 等 fs 异常返回 false，导致 cause 丢失）：
  // ENOENT 按真缺失（无 cause 合理），其他错误附 cause
  let stat;
  try {
    stat = lstatSync(outputRoot);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw observerError(
        TRACE_ERROR_CODES.OUTPUT_ROOT_INVALID,
        `networkObserver: outputRoot does not exist: ${outputRoot}`,
      );
    }
    throw observerError(
      TRACE_ERROR_CODES.OUTPUT_ROOT_INVALID,
      `networkObserver: outputRoot lstat failed: ${outputRoot}: ${error.message}`,
      error,
    );
  }
  if (!stat.isDirectory()) {
    throw observerError(
      TRACE_ERROR_CODES.OUTPUT_ROOT_INVALID,
      `networkObserver: outputRoot is not a directory: ${outputRoot}`,
    );
  }
  if (stat.isSymbolicLink()) {
    throw observerError(
      TRACE_ERROR_CODES.OUTPUT_ROOT_INVALID,
      `networkObserver: outputRoot is a symlink: ${outputRoot}`,
    );
  }

  // 2. 安全递归收集所有 trace.zip 路径
  const resolvedRoot = realpathSync(outputRoot);
  const traceZips = [];
  collectTraceZips(resolvedRoot, resolvedRoot, traceZips);

  // 按项目相对路径字典序排序
  traceZips.sort((a, b) => {
    const relA = relative(resolvedRoot, a);
    const relB = relative(resolvedRoot, b);
    return relA < relB ? -1 : relA > relB ? 1 : 0;
  });

  if (traceZips.length === 0) {
    throw observerError(
      TRACE_ERROR_CODES.MISSING,
      'networkObserver: no trace.zip found in outputRoot',
    );
  }

  // 3. 处理每个 trace.zip
  const allEntries = [];
  for (const zipPath of traceZips) {
    // 验证归档中精确只有一个 trace.network entry
    let listOutput;
    try {
      listOutput = execFileSync('/usr/bin/unzip', ['-Z1', zipPath], {
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw observerError(
        TRACE_ERROR_CODES.ARCHIVE_INVALID,
        `networkObserver: unzip -Z1 failed for ${zipPath}: ${error.message}`,
        error,
      );
    }

    const entries = listOutput.split('\n').filter(line => line.trim());
    const networkEntries = entries.filter(entry => /^(?:[0-9]+-)?trace\.network$/.test(entry));
    if (networkEntries.length !== 1) {
      throw observerError(
        TRACE_ERROR_CODES.ARCHIVE_INVALID,
        `networkObserver: archive must contain exactly one trace.network, got ${networkEntries.length} in ${zipPath}`,
      );
    }

    // 读取 trace.network 内容
    let content;
    const networkEntry = networkEntries[0];
    try {
      content = execFileSync('/usr/bin/unzip', ['-p', zipPath, networkEntry], {
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw observerError(
        TRACE_ERROR_CODES.ARCHIVE_INVALID,
        `networkObserver: unzip -p failed for ${zipPath}: ${error.message}`,
        error,
      );
    }

    // 逐行解析 JSON，只投影 type:"resource-snapshot"
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;

      let event;
      try {
        event = JSON.parse(line);
      } catch (parseError) {
        throw observerError(
          TRACE_ERROR_CODES.CONTENT_INVALID,
          `networkObserver: malformed JSON in ${zipPath}: ${JSON.stringify(line)}`,
          parseError,
        );
      }

      if (event.type !== 'resource-snapshot') continue;

      // 只投影 snapshot.request.url
      const url = event?.snapshot?.request?.url;
      if (!url || typeof url !== 'string') {
        throw observerError(
          TRACE_ERROR_CODES.CONTENT_INVALID,
          `networkObserver: resource entry missing URL in ${zipPath}`,
        );
      }

      // URL 必须是可解析的绝对 URL
      try {
        new URL(url);
      } catch (urlError) {
        throw observerError(
          TRACE_ERROR_CODES.CONTENT_INVALID,
          `networkObserver: URL is not a valid absolute URL in ${zipPath}: ${url}`,
          urlError,
        );
      }

      allEntries.push(url);
    }
  }

  // 7. 全部 trace 没有 resource entry 时抛错
  if (allEntries.length === 0) {
    throw observerError(
      TRACE_ERROR_CODES.EMPTY,
      'networkObserver: no resource entries found in any trace',
    );
  }

  // 8. 返回 {url, hop}，hop 从 0 连续编号
  return allEntries.map((url, hop) => ({ url, hop }));
}

/**
 * 安全递归收集 trace.zip 路径。
 * 遇到 symlink 或 containment 不明时抛错。
 */
function collectTraceZips(base, dir, result) {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const st = lstatSync(fullPath);

    // 遇到 symlink 立即抛错
    if (st.isSymbolicLink()) {
      throw observerError(
        TRACE_ERROR_CODES.OUTPUT_ROOT_INVALID,
        `networkObserver: symlink encountered during traversal: ${fullPath}`,
      );
    }

    if (st.isDirectory()) {
      collectTraceZips(base, fullPath, result);
    } else if (st.isFile() && entry === 'trace.zip') {
      // 验证 containment
      const resolved = realpathSync(fullPath);
      if (!resolved.startsWith(base)) {
        throw observerError(
          TRACE_ERROR_CODES.OUTPUT_ROOT_INVALID,
          `networkObserver: trace.zip escapes outputRoot: ${fullPath}`,
        );
      }
      result.push(resolved);
    }
  }
}

// ─── resource observer ───

/**
 * 资源观测：只接受真实 process-tree-sampling observation。
 *
 * mechanism 必须精确匹配、sampleCount >= 1、两个峰值为有限非负数；
 * 否则抛错。不得重采样、补值或回退。
 *
 * @param {{ run: object }} ctx
 * @returns {object} resourceObservation
 */
export function resourceObserver(ctx) {
  const { run } = ctx;
  if (!run || typeof run !== 'object') {
    throw new Error('resourceObserver: run object is required');
  }

  const obs = run.resourceObservation;
  if (!obs || typeof obs !== 'object') {
    throw new Error('resourceObserver: resourceObservation not found on run');
  }

  if (obs.mechanism !== 'process-tree-sampling:/bin/ps') {
    throw new Error(`resourceObserver: unexpected mechanism: ${obs.mechanism}`);
  }

  if (!Number.isInteger(obs.sampleCount) || obs.sampleCount < 1) {
    throw new Error(`resourceObserver: sampleCount must be >= 1, got ${obs.sampleCount}`);
  }

  if (typeof obs.cpuPeak !== 'number' || !Number.isFinite(obs.cpuPeak) || obs.cpuPeak < 0) {
    throw new Error(`resourceObserver: cpuPeak must be a finite non-negative number, got ${obs.cpuPeak}`);
  }

  if (typeof obs.memPeakMB !== 'number' || !Number.isFinite(obs.memPeakMB) || obs.memPeakMB < 0) {
    throw new Error(`resourceObserver: memPeakMB must be a finite non-negative number, got ${obs.memPeakMB}`);
  }

  return obs;
}

// ─── playwright runner ───

/**
 * Playwright runner：真实执行命令并采样进程组资源。
 *
 * 机械合同：
 * 1. 外层只用 spawnSync(process.execPath, [hostFile, helperFlag], ...) 参数数组，shell:false；
 * 2. helper 用 spawn(command, args, { detached:true, shell:false }) 启动真实命令；
 * 3. helper 立即采样并以 25-50ms 周期调用绝对 /bin/ps 参数数组；
 * 4. 严格解析完整快照，筛选同一 PGID 的所有非 zombie 成员；
 * 5. helper 真实收集目标 stdout/stderr/status，遵守 timeout 与 maxBuffer；
 * 6. 外层严格解析 helper 的单一 JSON 结果，返回 spawnSync 兼容格式。
 *
 * @param {string} command
 * @param {string[]} args
 * @param {object} options
 * @param {object} context
 * @returns {{ status: number|null, stdout: string, stderr: string, errorCode?: string, resourceObservation: object }}
 */
export function playwrightRunner(command, args, options, context) {
  const hostFile = fileURLToPath(import.meta.url);
  const timeoutMs = options.timeout || 30000;
  const maxBuffer = options.maxBuffer || 1024 * 1024;

  // 前置验证 context：缺失或畸形直接返回 RESOURCE_INVALID_BUDGET，目标零副作用
  if (!context || typeof context !== 'object') {
    return {
      status: null,
      stdout: '',
      stderr: '',
      errorCode: 'RESOURCE_INVALID_BUDGET',
      resourceObservation: { mechanism: 'process-tree-sampling:/bin/ps', cpuPeak: 0, memPeakMB: 0, sampleCount: 0 },
    };
  }

  const { resourceBudget, timeouts } = context;

  // 验证 resourceBudget 和 timeouts 存在
  if (!resourceBudget || typeof resourceBudget !== 'object' ||
      !timeouts || typeof timeouts !== 'object') {
    return {
      status: null,
      stdout: '',
      stderr: '',
      errorCode: 'RESOURCE_INVALID_BUDGET',
      resourceObservation: { mechanism: 'process-tree-sampling:/bin/ps', cpuPeak: 0, memPeakMB: 0, sampleCount: 0 },
    };
  }

  // 验证 CPU/内存畸形
  if (typeof resourceBudget.cpu !== 'number' || !Number.isFinite(resourceBudget.cpu) || resourceBudget.cpu <= 0 ||
      !Number.isInteger(resourceBudget.memMB) || resourceBudget.memMB < 128) {
    return {
      status: null,
      stdout: '',
      stderr: '',
      errorCode: 'RESOURCE_INVALID_BUDGET',
      resourceObservation: { mechanism: 'process-tree-sampling:/bin/ps', cpuPeak: 0, memPeakMB: 0, sampleCount: 0 },
    };
  }

  // 验证 options.timeout 与 timeouts.total 漂移
  if (!Number.isInteger(timeouts.total) || timeouts.total <= 0 || timeouts.total !== timeoutMs) {
    return {
      status: null,
      stdout: '',
      stderr: '',
      errorCode: 'RESOURCE_INVALID_BUDGET',
      resourceObservation: { mechanism: 'process-tree-sampling:/bin/ps', cpuPeak: 0, memPeakMB: 0, sampleCount: 0 },
    };
  }

  // 序列化选项到环境变量（secret env 不进入 argv）
  const helperEnv = {
    ...process.env,
    ...options.env,
    __PLAYWRIGHT_COMMAND: command,
    __PLAYWRIGHT_ARGS: JSON.stringify(args),
    __PLAYWRIGHT_CWD: options.cwd || process.cwd(),
    __PLAYWRIGHT_ENCODING: options.encoding || 'utf8',
    __PLAYWRIGHT_TIMEOUT: String(timeoutMs),
    __PLAYWRIGHT_MAX_BUFFER: String(maxBuffer),
    __PLAYWRIGHT_CPU_LIMIT: String(resourceBudget.cpu),
    __PLAYWRIGHT_MEM_LIMIT_MB: String(resourceBudget.memMB),
    __PLAYWRIGHT_TIMEOUT_TOTAL: String(timeouts.total),
  };

  // 外层用 spawnSync，shell:false，secret env 不进入 argv
  const result = spawnSync(process.execPath, [hostFile, '--playwright-helper'], {
    encoding: 'utf8',
    timeout: timeoutMs + 5000, // 给 helper 额外时间完成终止序列
    // stdout buffer 至少 maxBuffer * 4 + 1MiB
    maxBuffer: maxBuffer * 4 + 1024 * 1024,
    env: helperEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });

  // 明确处理 spawnSync 错误
  if (result.error) {
    throw new Error(`playwrightRunner: spawnSync failed: ${result.error.message}`);
  }

  // helper 非 0 status 必须让 M5 失败关闭
  if (result.status !== 0) {
    throw new Error(`playwrightRunner: helper exited with status ${result.status}, stderr: ${result.stderr || ''}`);
  }

  // 处理空 stdout
  const stdout = result.stdout || '';
  if (!stdout) {
    throw new Error('playwrightRunner: helper returned empty stdout');
  }

  // 严格解析 helper 的单一 JSON 结果
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`playwrightRunner: failed to parse helper output: ${error.message}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('playwrightRunner: helper returned non-object');
  }

  // 提取 resourceObservation
  const resourceObservation = parsed.resourceObservation;
  if (!resourceObservation) {
    throw new Error('playwrightRunner: helper did not return resourceObservation');
  }

  // 返回 spawnSync 兼容格式
  const outerResult = {
    status: parsed.status,
    stdout: parsed.stdout || '',
    stderr: parsed.stderr || '',
    resourceObservation,
  };

  // cleanupErrorCode 优先暴露为 errorCode，原 errorCode 以 causeErrorCode 保留
  if (parsed.cleanupErrorCode) {
    outerResult.errorCode = parsed.cleanupErrorCode;
    if (parsed.errorCode) {
      outerResult.causeErrorCode = parsed.errorCode;
    }
  } else if (parsed.errorCode) {
    outerResult.errorCode = parsed.errorCode;
  }

  return outerResult;
}

/**
 * helper 主逻辑：用 spawn 启动真实命令，进行进程组采样。
 * 从环境变量读取配置。
 *
 * 统一失败状态机 beginFailure：首个 terminalErrorCode 胜出，
 * TERM→250ms→KILL→poll，供 buffer/timeout/sampling/spawn failure 共用。
 * 幂等 finalizer，只写一次 helper JSON。
 */
function runPlaywrightHelper() {
  const command = process.env.__PLAYWRIGHT_COMMAND;
  const argsRaw = process.env.__PLAYWRIGHT_ARGS;
  const cwd = process.env.__PLAYWRIGHT_CWD;
  const encoding = process.env.__PLAYWRIGHT_ENCODING || 'utf8';
  const timeout = Number(process.env.__PLAYWRIGHT_TIMEOUT) || 30000;
  const maxBuffer = Number(process.env.__PLAYWRIGHT_MAX_BUFFER) || 1024 * 1024;

  // 资源预算：第二次同形验证，防止环境传递漂移
  const cpuLimitRaw = process.env.__PLAYWRIGHT_CPU_LIMIT;
  const memLimitMBRaw = process.env.__PLAYWRIGHT_MEM_LIMIT_MB;
  const timeoutTotalRaw = process.env.__PLAYWRIGHT_TIMEOUT_TOTAL;

  // outer host 应该已经设置了这些环境变量，缺失则说明环境传递失败
  if (cpuLimitRaw === undefined || memLimitMBRaw === undefined || timeoutTotalRaw === undefined) {
    writeSync(1, JSON.stringify({ status: null, stdout: '', stderr: '', errorCode: 'RESOURCE_INVALID_BUDGET', resourceObservation: { mechanism: 'process-tree-sampling:/bin/ps', cpuPeak: 0, memPeakMB: 0, sampleCount: 0 } }));
    return;
  }

  const cpuLimit = Number(cpuLimitRaw);
  const memLimitMB = Number(memLimitMBRaw);
  const timeoutTotal = Number(timeoutTotalRaw);

  // 验证 CPU/内存畸形
  if (!Number.isFinite(cpuLimit) || cpuLimit <= 0 ||
      !Number.isInteger(memLimitMB) || memLimitMB < 128 ||
      !Number.isInteger(timeoutTotal) || timeoutTotal <= 0 || timeoutTotal !== timeout) {
    writeSync(1, JSON.stringify({ status: null, stdout: '', stderr: '', errorCode: 'RESOURCE_INVALID_BUDGET', resourceObservation: { mechanism: 'process-tree-sampling:/bin/ps', cpuPeak: 0, memPeakMB: 0, sampleCount: 0 } }));
    return;
  }

  if (!command) {
    writeSync(1, JSON.stringify({ status: null, stdout: '', stderr: '', errorCode: 'HELPER_MISSING_COMMAND' }));
    return;
  }

  let args;
  try {
    args = JSON.parse(argsRaw || '[]');
  } catch {
    writeSync(1, JSON.stringify({ status: null, stdout: '', stderr: '', errorCode: 'HELPER_INVALID_ARGS' }));
    return;
  }

  if (!Array.isArray(args)) {
    writeSync(1, JSON.stringify({ status: null, stdout: '', stderr: '', errorCode: 'HELPER_ARGS_NOT_ARRAY' }));
    return;
  }

  // 清理 __PLAYWRIGHT_* helper 控制字段，保留 M5 传入的其他 env/secret
  const childEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('__PLAYWRIGHT_')) {
      childEnv[key] = value;
    }
  }

  // 直接以独立进程组启动真实命令；网络性质由 networkObserver 举证
  // （被否决的 sandbox-exec 包装已随 Attempt 003 移除，Node 3.1 保持 blocked）。
  // 用 spawn(detached:true, shell:false) 启动真实命令
  let child;
  try {
    child = spawn(command, args, {
      cwd,
      env: childEnv,
      detached: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    writeSync(1, JSON.stringify({
      status: null, stdout: '', stderr: '',
      errorCode: 'RESOURCE_SPAWN_FAILED',
      resourceObservation: { mechanism: 'process-tree-sampling:/bin/ps', cpuPeak: 0, memPeakMB: 0, sampleCount: 0 },
    }));
    return;
  }

  // 一次性异步 error listener：spawn 后异步失败（如 ENOENT）路径
  child.once('error', () => {
    if (terminalErrorCode === null) {
      terminalErrorCode = 'RESOURCE_SPAWN_FAILED';
    }
    childClosed = true;
    finalize();
  });

  const pgid = child.pid;

  // 收集 stdout/stderr
  const stdoutChunks = [];
  const stderrChunks = [];
  let stdoutSize = 0;
  let stderrSize = 0;

  // ─── 统一失败状态机 ───
  let terminalErrorCode = null;
  let cleanupErrorCode = null;
  let failureInitiated = false;
  let childClosed = false;
  let exitStatus = null;
  let finalized = false;

  // 所有 timer 引用，finalizer 需要清理
  const timers = new Set();

  function scheduleTimer(fn, ms) {
    const id = setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
    return id;
  }

  function clearAllTimers() {
    for (const id of timers) clearTimeout(id);
    timers.clear();
  }

  /**
   * 向全部追踪 PGID 和追踪 PID 发送信号。仅 ESRCH 表示目标不存在。
   * 非 ESRCH 异常记录 cleanupErrorCode，不静默吞掉。
   * 追踪集 = 直接 PGID ∪ 以直接子进程为根的完整派生树（Attempt 004）。
   */
  function signalTree(signal) {
    for (const group of trackedPgids) {
      try {
        process.kill(-group, signal);
      } catch (error) {
        if (error?.code === 'ESRCH') continue;
        cleanupErrorCode = 'RESOURCE_CLEANUP_FAILED';
      }
    }
    for (const pid of trackedPids) {
      try {
        process.kill(pid, signal);
      } catch (error) {
        if (error?.code === 'ESRCH') continue;
        cleanupErrorCode = 'RESOURCE_CLEANUP_FAILED';
      }
    }
  }

  /**
   * 追踪集中是否仍有非 zombie 成员。/bin/ps 失败时抛错，由调用方
   * 按 cleanup 失败处理，不把异常解释成树已停止。
   */
  function treeMembersAlive() {
    const output = execFileSync('/bin/ps', [
      '-axo', 'pid=,stat=',
    ], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    for (const rawLine of output.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const parts = line.split(/\s+/);
      if (parts.length < 2) {
        throw new Error(`treeMembersAlive: malformed ps line: ${JSON.stringify(line)}`);
      }
      const pid = Number(parts[0]);
      const stat = parts[1];
      if (!Number.isInteger(pid) || pid <= 0 || !stat) {
        throw new Error(`treeMembersAlive: unparseable ps line: ${JSON.stringify(line)}`);
      }
      if (trackedPids.has(pid) && !stat.startsWith('Z')) return true;
    }
    return false;
  }

  /**
   * 统一失败状态机入口。首个 terminalErrorCode 胜出。
   * TERM→250ms→KILL→poll，供 buffer/timeout/sampling/spawn failure 共用。
   */
  function beginFailure(code) {
    // 首个 terminalErrorCode 胜出，后续调用直接返回
    if (terminalErrorCode !== null) return;
    terminalErrorCode = code;
    if (failureInitiated) return;
    failureInitiated = true;

    // 对完整派生树发 SIGTERM
    signalTree('SIGTERM');

    // 250ms 后对完整派生树发 SIGKILL
    scheduleTimer(() => {
      signalTree('SIGKILL');
    }, 250);

    // 每 25-50ms 轮询，child close 且派生树无非 zombie 后 finalize
    function pollForFinalize() {
      if (finalized) return;
      let canFinalize = false;
      try {
        canFinalize = childClosed && !treeMembersAlive();
      } catch {
        // /bin/ps 失败：记录 cleanup 失败，不把异常解释成树已停止
        cleanupErrorCode = 'RESOURCE_CLEANUP_FAILED';
        canFinalize = childClosed;
      }
      if (canFinalize) {
        finalize();
      } else {
        scheduleTimer(pollForFinalize, 30);
      }
    }
    scheduleTimer(pollForFinalize, 30);
  }

  // 派生树追踪集：直接 PGID ∪ ppid 链闭包（Attempt 004）
  const trackedPids = new Set([pgid]);
  const trackedPgids = new Set([pgid]);

  // 进程树采样状态
  let cpuPeak = 0;
  let memPeakMB = 0;
  let sampleCount = 0;
  let everSampled = false;

  function sampleProcessGroup() {
    if (terminalErrorCode !== null) return;
    let psOutput;
    try {
      psOutput = execFileSync('/bin/ps', [
        '-axo', 'pid=,pgid=,ppid=,%cpu=,rss=,stat=',
      ], {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      beginFailure('RESOURCE_SAMPLING_FAILED');
      return;
    }

    const processes = [];
    for (const rawLine of psOutput.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const parts = line.split(/\s+/);
      if (parts.length < 6) {
        beginFailure('RESOURCE_SAMPLING_FAILED');
        return;
      }

      const pid = Number(parts[0]);
      const memberPgid = Number(parts[1]);
      const ppid = Number(parts[2]);
      const cpu = Number(parts[3]);
      const rss = Number(parts[4]);
      const stat = parts[5];

      if (!Number.isInteger(pid) || pid <= 0 ||
          !Number.isInteger(memberPgid) || memberPgid <= 0 ||
          !Number.isInteger(ppid) || ppid < 0 ||
          !Number.isFinite(cpu) || !Number.isFinite(rss) ||
          !stat) {
        beginFailure('RESOURCE_SAMPLING_FAILED');
        return;
      }
      processes.push({ pid, pgid: memberPgid, ppid, cpu, rss, stat });
    }

    // 以直接子进程为根，按 ppid 链计算完整派生树闭包
    const childrenByPpid = new Map();
    for (const entry of processes) {
      if (!childrenByPpid.has(entry.ppid)) childrenByPpid.set(entry.ppid, []);
      childrenByPpid.get(entry.ppid).push(entry);
    }
    const descendants = new Set();
    const queue = [pgid];
    while (queue.length > 0) {
      const current = queue.pop();
      for (const childEntry of childrenByPpid.get(current) || []) {
        if (!descendants.has(childEntry.pid)) {
          descendants.add(childEntry.pid);
          queue.push(childEntry.pid);
        }
      }
    }

    let groupCpu = 0;
    let groupRssKB = 0;
    let hasNonZombie = false;
    for (const entry of processes) {
      if (entry.stat.startsWith('Z')) continue;
      if (entry.pgid === pgid || descendants.has(entry.pid)) {
        // 见过的所有非 zombie 成员进入持久追踪集，reparent 后仍在终止序列内
        trackedPids.add(entry.pid);
        trackedPgids.add(entry.pgid);
        hasNonZombie = true;
        groupCpu += entry.cpu;
        groupRssKB += entry.rss;
      }
    }

    if (hasNonZombie) {
      everSampled = true;
      const cpuNorm = groupCpu / 100;
      const memMB = groupRssKB / 1024;
      if (cpuNorm > cpuPeak) cpuPeak = cpuNorm;
      if (memMB > memPeakMB) memPeakMB = memMB;
      sampleCount++;
      // 资源越界立即终止：首个 terminal error 胜出
      if (cpuPeak > cpuLimit) {
        beginFailure('RESOURCE_CPU_LIMIT');
      } else if (memPeakMB > memLimitMB) {
        beginFailure('RESOURCE_MEMORY_LIMIT');
      }
    }
  }

  /** 幂等 finalizer：只写一次 helper JSON */
  function finalize() {
    if (finalized) return;
    finalized = true;
    clearAllTimers();

    const stdout = Buffer.concat(stdoutChunks).toString(encoding);
    const stderr = Buffer.concat(stderrChunks).toString(encoding);

    // 决定最终 errorCode
    let errorCode = terminalErrorCode;
    if (!errorCode && exitStatus !== null && !everSampled) {
      errorCode = 'RESOURCE_NO_SAMPLES';
    }

    const result = {
      status: exitStatus,
      stdout,
      stderr,
    };

    if (errorCode) result.errorCode = errorCode;
    if (cleanupErrorCode) result.cleanupErrorCode = cleanupErrorCode;

    result.resourceObservation = {
      mechanism: 'process-tree-sampling:/bin/ps',
      cpuPeak,
      memPeakMB,
      sampleCount,
      trackedPids: [...trackedPids].sort((a, b) => a - b),
    };

    writeSync(1, JSON.stringify(result));
    process.exit(0);
  }

  // buffer data handlers
  child.stdout.on('data', (chunk) => {
    if (terminalErrorCode !== null) return;
    stdoutSize += chunk.length;
    if (stdoutSize > maxBuffer) {
      beginFailure('RESOURCE_BUFFER_OVERFLOW');
    } else {
      stdoutChunks.push(chunk);
    }
  });

  child.stderr.on('data', (chunk) => {
    if (terminalErrorCode !== null) return;
    stderrSize += chunk.length;
    if (stderrSize > maxBuffer) {
      beginFailure('RESOURCE_BUFFER_OVERFLOW');
    } else {
      stderrChunks.push(chunk);
    }
  });

  // 立即采样一次
  sampleProcessGroup();

  // 以 30ms 周期采样
  const sampleInterval = setInterval(sampleProcessGroup, 30);
  timers.add(sampleInterval);

  // 超时：单次 setTimeout 调用 beginFailure
  scheduleTimer(() => {
    beginFailure('RESOURCE_TIMEOUT');
  }, timeout);

  // 子进程退出
  child.on('close', (code) => {
    exitStatus = code;
    childClosed = true;

    // 正常 close 也必须确认完整派生树无非 zombie 后才 finalize
    if (!failureInitiated) {
      // 非失败路径：等最后一次采样后确认派生树清理
      scheduleTimer(() => {
        try {
          if (!treeMembersAlive()) {
            finalize();
          } else {
            // 派生树仍有成员（含 detached 逃逸），进入终止序列
            beginFailure(terminalErrorCode || 'RESOURCE_TIMEOUT');
          }
        } catch {
          // treeMembersAlive 失败：记录 cleanup 失败后 finalize
          cleanupErrorCode = 'RESOURCE_CLEANUP_FAILED';
          finalize();
        }
      }, 50);
    }
    // 失败路径的 pollForFinalize 会自行处理
  });
}

// ─── teardown inspector ───

/**
 * teardown 检查：验证进程组和端口状态。只观察，不杀进程。
 * 进程组和端口必须真实、明确；URL、lsof 或状态不明确时抛错。
 * 使用 /usr/sbin/lsof -nP -iTCP:<port> -sTCP:LISTEN -t 参数数组。
 * @param {{ plan: object, runId: string, run: object, outputRoot: string, lifecycle: object|null, phase?: string }} ctx
 * @returns {{ processes: Array, ports: Array }}
 */
export function teardownInspector(ctx) {
  const { lifecycle, plan } = ctx;
  const processes = [];
  const ports = [];

  // 检查 lifecycle 进程组状态（只观察，不杀进程）
  if (lifecycle?.pid && lifecycle?.pgid) {
    processes.push({
      pid: lifecycle.pid,
      kind: 'server',
      started: true,
      stopped: !groupMembersAlive(lifecycle.pgid),
    });
  }

  // 检查 server 端口是否释放
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

  // 使用 /usr/sbin/lsof 参数数组检查端口
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
    });
    // lsof 有输出表示端口被占用
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

// ─── helper 入口点（模块作为脚本执行时） ───

// helper 入口：精确匹配当前文件路径和 helper flag，不用 process.argv.includes
const __helperHostPath = fileURLToPath(import.meta.url);
if (process.argv[1] === __helperHostPath && process.argv[2] === '--playwright-helper') {
  runPlaywrightHelper();
}
