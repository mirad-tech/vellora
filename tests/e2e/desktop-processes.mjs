/**
 * Desktop E2E process helpers (Windows).
 *
 * Fail-closed process listing + session-token ownership selection.
 * Importing this module never starts desktop E2E.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class DesktopE2EError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DesktopE2EError';
  }
}

export const SESSION_FLAG_PREFIX = '--vellora-e2e-session=';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidSessionToken(token) {
  return typeof token === 'string' && UUID_RE.test(token);
}

export function buildSessionArg(session) {
  return `${SESSION_FLAG_PREFIX}${session}`;
}

export function pathsEqual(a, b) {
  if (!a || !b) return false;
  return path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase();
}

export function normalizePid(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Command line must contain the full launch flag as a discrete argument,
 * not merely as a prefix or as a substring of a file path.
 */
export function commandLineHasSession(commandLine, session) {
  if (typeof commandLine !== 'string' || !isValidSessionToken(session)) return false;
  const flag = buildSessionArg(session);
  const re = new RegExp(`(?:^|[\\s"])${escapeRegExp(flag)}(?:[\\s"]|$)`);
  return re.test(commandLine);
}

/**
 * Normalize processes field from PowerShell ConvertTo-Json.
 * PS 5.1 often collapses a single-element array property to a bare object.
 */
export function normalizeProcessesField(processes) {
  if (Array.isArray(processes)) return processes;
  if (
    processes &&
    typeof processes === 'object' &&
    (processes.ProcessId != null ||
      processes.processId != null ||
      processes.pid != null)
  ) {
    return [processes];
  }
  return null;
}

/**
 * Strict parse of PowerShell JSON: { ok: true, processes: [...] }.
 * Throws DesktopE2EError on any invalid structure.
 */
export function parseProcessQueryJson(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new DesktopE2EError(
      '无法确认 Vellora 进程状态：进程查询返回空输出。'
    );
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new DesktopE2EError(
      '无法确认 Vellora 进程状态：进程查询返回的 JSON 无法解析。'
    );
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new DesktopE2EError(
      '无法确认 Vellora 进程状态：进程查询结果结构不合法。'
    );
  }
  if (data.ok !== true) {
    throw new DesktopE2EError(
      '无法确认 Vellora 进程状态：查询结果缺少 ok=true。'
    );
  }

  const rawList = normalizeProcessesField(data.processes);
  if (rawList == null) {
    throw new DesktopE2EError(
      '无法确认 Vellora 进程状态：processes 字段缺失或不是数组。'
    );
  }

  const processes = [];
  for (const item of rawList) {
    if (!item || typeof item !== 'object') {
      throw new DesktopE2EError(
        '无法确认 Vellora 进程状态：processes 中存在非法条目。'
      );
    }
    const pid = normalizePid(item.ProcessId ?? item.processId ?? item.pid);
    if (pid == null) {
      throw new DesktopE2EError(
        '无法确认 Vellora 进程状态：存在无法转换为正整数的 PID。'
      );
    }
    processes.push({
      pid,
      executablePath: item.ExecutablePath ?? item.executablePath ?? null,
      commandLine: item.CommandLine ?? item.commandLine ?? null,
      creationDate: item.CreationDate ?? item.creationDate ?? null
    });
  }
  return processes;
}

/**
 * Only processes that match release binary path AND the full session flag.
 * Missing path/command line or invalid ownership data are excluded (not guessed).
 */
export function selectOwnedTestVellora(processes, { appBinary, session }) {
  if (!Array.isArray(processes)) return [];
  if (!appBinary || !isValidSessionToken(session)) return [];

  const owned = [];
  for (const p of processes) {
    const pid = normalizePid(p?.pid ?? p?.ProcessId ?? p?.processId);
    if (pid == null) continue;
    const executablePath = p.executablePath ?? p.ExecutablePath ?? null;
    const commandLine = p.commandLine ?? p.CommandLine ?? null;
    if (!executablePath || typeof commandLine !== 'string') continue;
    if (!pathsEqual(executablePath, appBinary)) continue;
    if (!commandLineHasSession(commandLine, session)) continue;
    owned.push(pid);
  }
  return owned;
}

/**
 * Release-path matches that are NOT session-owned (do not kill; may fail cleanup).
 */
export function selectUnownedReleasePathVellora(processes, { appBinary, session }) {
  if (!Array.isArray(processes) || !appBinary) return [];
  const owned = new Set(selectOwnedTestVellora(processes, { appBinary, session }));
  const unowned = [];
  for (const p of processes) {
    const pid = normalizePid(p?.pid ?? p?.ProcessId ?? p?.processId);
    if (pid == null || owned.has(pid)) continue;
    const executablePath = p.executablePath ?? p.ExecutablePath ?? null;
    if (!executablePath || !pathsEqual(executablePath, appBinary)) continue;
    unowned.push(pid);
  }
  return unowned;
}

/**
 * Build JSON manually so Windows PowerShell 5.1 never collapses a one-item
 * processes array into a bare object.
 */
const LIST_VELLORA_PS1 = `
$ErrorActionPreference = 'Stop'
try {
  $procs = @(Get-CimInstance Win32_Process -Filter "Name = 'vellora.exe'")
  $items = New-Object System.Collections.Generic.List[object]
  foreach ($p in $procs) {
    $items.Add([PSCustomObject]@{
      ProcessId = [int]$p.ProcessId
      ExecutablePath = $p.ExecutablePath
      CommandLine = $p.CommandLine
      CreationDate = if ($p.CreationDate) { $p.CreationDate.ToString('o') } else { $null }
    }) | Out-Null
  }
  if ($items.Count -eq 0) {
    $procJson = '[]'
  } elseif ($items.Count -eq 1) {
    $procJson = '[' + ($items[0] | ConvertTo-Json -Compress -Depth 6) + ']'
  } else {
    $procJson = ($items.ToArray() | ConvertTo-Json -Compress -Depth 6)
  }
  Write-Output ('{"ok":true,"processes":' + $procJson + '}')
  exit 0
} catch {
  Write-Error $_
  exit 1
}
`.trim();

/**
 * Query running vellora.exe processes. Fail-closed: any error throws DesktopE2EError.
 * @param {{ execFileSyncFn?: typeof execFileSync, tmpDir?: string }} [options]
 * @returns {Array<{ pid: number, executablePath: string|null, commandLine: string|null, creationDate: string|null }>}
 */
export function listVelloraProcesses(options = {}) {
  const execFile = options.execFileSyncFn || execFileSync;
  const tmpDir = options.tmpDir || os.tmpdir();
  const tmp = path.join(
    tmpDir,
    `vellora-e2e-list-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.ps1`
  );

  try {
    fs.writeFileSync(tmp, LIST_VELLORA_PS1, 'utf8');
  } catch (err) {
    throw new DesktopE2EError(
      `无法确认 Vellora 进程状态：无法写入查询脚本（${err?.message || err}）。`
    );
  }

  let stdout = '';
  try {
    stdout = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmp],
      {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024
      }
    );
    if (typeof stdout !== 'string') {
      stdout = stdout == null ? '' : String(stdout);
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    if (err?.code === 'ENOENT') {
      throw new DesktopE2EError(
        '无法确认 Vellora 进程状态：无法启动 powershell.exe。'
      );
    }
    const stderr = typeof err?.stderr === 'string' ? err.stderr : '';
    const detail = (stderr || err?.message || String(err)).trim();
    throw new DesktopE2EError(
      `无法确认 Vellora 进程状态：CIM/PowerShell 查询失败${detail ? `（${detail}）` : ''}。`
    );
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
  }

  return parseProcessQueryJson(stdout.trim());
}

/**
 * Assert no Vellora is running. Continues only when query succeeds with empty list.
 */
export function assertNoPreexistingVellora(listFn = listVelloraProcesses) {
  const procs = listFn();
  if (procs.length === 0) return;
  const lines = procs.map((p) => {
    const exe = p.executablePath || '(path unknown)';
    return `  PID ${p.pid}: ${exe}`;
  });
  throw new DesktopE2EError(
    '检测到已有 Vellora 正在运行。为保护未保存内容，测试不会结束或操作这些进程。\n' +
      '请先保存并关闭所有 Vellora 窗口后重试：\n' +
      lines.join('\n')
  );
}

/**
 * Kill a process tree by PID (Windows taskkill /T /F). Never uses image name.
 * @returns {{ ok: boolean, status?: number|null, skipped?: boolean }}
 */
export function killPidTreeSafe(pid, { spawnSyncFn = spawnSync } = {}) {
  const n = normalizePid(pid);
  if (n == null) return { ok: true, skipped: true };
  try {
    const r = spawnSyncFn('taskkill', ['/PID', String(n), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    });
    const status = typeof r?.status === 'number' ? r.status : null;
    // 0 = killed; 128 = process not found (already gone) — both OK for cleanup.
    if (status === 0 || status === 128) {
      return { ok: true, status };
    }
    // Some Windows builds use 1 when the process is already gone.
    if (status === 1 && r?.error == null) {
      return { ok: true, status };
    }
    if (status == null && !r?.error) {
      return { ok: true, status: 0 };
    }
    return { ok: false, status };
  } catch (err) {
    return { ok: false, status: null, error: err };
  }
}

/**
 * Idempotent cleanup controller for desktop E2E.
 *
 * Order:
 *  1. WDIO PID tree (spawned by script)
 *  2. tauri-driver PID tree (spawned by script)
 *  3. re-query Vellora; kill only session-owned PIDs
 *  4. re-query; fail if owned still alive or release-path unowned orphans remain
 *  5. remove fixture dir
 *
 * If Vellora re-query fails: never taskkill unverified Vellora PIDs; mark cleanupFailed.
 */
export function createCleanupController(deps = {}) {
  const listProcesses = deps.listVelloraProcesses || listVelloraProcesses;
  const selectOwned = deps.selectOwnedTestVellora || selectOwnedTestVellora;
  const selectUnownedPath =
    deps.selectUnownedReleasePathVellora || selectUnownedReleasePathVellora;
  const killTree = deps.killPidTree || killPidTreeSafe;
  const rmSync =
    deps.rmSync ||
    ((dir) => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
  const logError = deps.logError || ((msg) => console.error(msg));

  let cleaned = false;
  let cleanupFailed = false;

  const markFailed = (message) => {
    cleanupFailed = true;
    logError(
      '\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n' +
        `[e2e:desktop] CLEANUP FAILED: ${message}\n` +
        '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n'
    );
  };

  return {
    get cleaned() {
      return cleaned;
    },
    get cleanupFailed() {
      return cleanupFailed;
    },
    /**
     * @param {{
     *   wdioPid?: number|null,
     *   driverPid?: number|null,
     *   appBinary: string,
     *   session: string,
     *   fixtureDir?: string|null
     * }} state
     */
    cleanup(state) {
      if (cleaned) {
        return { cleanupFailed };
      }
      cleaned = true;

      // Helper/driver trees: best-effort (not ownership-sensitive for exit code).
      if (state.wdioPid) {
        killTree(state.wdioPid);
      }
      if (state.driverPid) {
        killTree(state.driverPid);
      }

      try {
        const procs = listProcesses();
        const owned = selectOwned(procs, {
          appBinary: state.appBinary,
          session: state.session
        });
        const unownedSamePath = selectUnownedPath(procs, {
          appBinary: state.appBinary,
          session: state.session
        });

        if (unownedSamePath.length > 0) {
          markFailed(
            '发现与 release vellora.exe 路径相同、但无法用本次会话令牌证明归属的进程；' +
              '不会调用 taskkill。\n' +
              `未验证 PID: ${unownedSamePath.join(', ')}\n` +
              '请手动检查这些进程（可能是令牌未出现在 CommandLine，或测试期间用户启动了同路径实例）。'
          );
        }

        const killFailures = [];
        for (const pid of owned) {
          const result = killTree(pid);
          if (result && result.ok === false) {
            killFailures.push(
              `PID ${pid}` + (result.status != null ? ` (taskkill exit ${result.status})` : '')
            );
          }
        }

        // Authoritative check: owned session instances must be gone after kill attempts.
        if (owned.length > 0) {
          const after = listProcesses();
          const stillOwned = selectOwned(after, {
            appBinary: state.appBinary,
            session: state.session
          });
          if (stillOwned.length > 0) {
            markFailed(
              `重新查询后仍有携带本次会话令牌的 Vellora：PID ${stillOwned.join(', ')}。` +
                (killFailures.length
                  ? `\ntaskkill 曾报告失败：${killFailures.join('; ')}`
                  : '')
            );
          } else if (killFailures.length > 0) {
            // Process gone (or not visible) despite non-zero taskkill — do not fail the run.
            logError(
              `[e2e:desktop] taskkill 返回非零，但重新查询未发现会话令牌实例：${killFailures.join('; ')}`
            );
          }
        }
      } catch (err) {
        cleanupFailed = true;
        const msg =
          err instanceof DesktopE2EError
            ? err.message
            : err?.message || String(err);
        logError(
          '\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n' +
            '[e2e:desktop] CLEANUP FAILED: 无法重新查询 Vellora 进程状态。\n' +
            '已结束本次脚本直接启动的 WDIO / tauri-driver（若有）。\n' +
            '不会对任何无法重新验证归属的 Vellora PID 调用 taskkill。\n' +
            `${msg}\n` +
            '请手动检查是否仍有携带本次 VELLORA_E2E_SESSION 的 Vellora 进程。\n' +
            '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n'
        );
      }

      if (state.fixtureDir) {
        try {
          rmSync(state.fixtureDir);
        } catch {
          // ignore fixture removal errors
        }
      }

      return { cleanupFailed };
    }
  };
}
