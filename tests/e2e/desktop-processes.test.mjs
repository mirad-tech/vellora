// @vitest-environment node

import { describe, expect, test, vi } from 'vitest';

import {
  DesktopE2EError,
  assertNoPreexistingVellora,
  buildSessionArg,
  commandLineHasSession,
  createCleanupController,
  listVelloraProcesses,
  parseProcessQueryJson,
  selectOwnedTestVellora
} from './desktop-processes.mjs';

const APP = 'G:\\mirad\\mirad-server\\md\\src-tauri\\target\\release\\vellora.exe';
const SESSION = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
const OTHER_SESSION = 'ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb';

describe('desktop-processes parseProcessQueryJson', () => {
  test('returns empty array when query succeeds with no processes', () => {
    const procs = parseProcessQueryJson(JSON.stringify({ ok: true, processes: [] }));
    expect(procs).toEqual([]);
  });

  test('throws on invalid JSON (does not return empty array)', () => {
    expect(() => parseProcessQueryJson('not-json{')).toThrow(DesktopE2EError);
    expect(() => parseProcessQueryJson('not-json{')).toThrow(/JSON|解析/);
  });

  test('throws when ok or processes field is missing', () => {
    expect(() => parseProcessQueryJson(JSON.stringify({ processes: [] }))).toThrow(
      DesktopE2EError
    );
    expect(() => parseProcessQueryJson(JSON.stringify({ ok: true }))).toThrow(DesktopE2EError);
    expect(() => parseProcessQueryJson(JSON.stringify({ ok: false, processes: [] }))).toThrow(
      DesktopE2EError
    );
    expect(() =>
      parseProcessQueryJson(JSON.stringify({ ok: true, processes: 'nope' }))
    ).toThrow(DesktopE2EError);
  });

  test('throws when a process entry has invalid PID', () => {
    expect(() =>
      parseProcessQueryJson(
        JSON.stringify({
          ok: true,
          processes: [{ ProcessId: 0, ExecutablePath: APP, CommandLine: 'x' }]
        })
      )
    ).toThrow(DesktopE2EError);
    expect(() =>
      parseProcessQueryJson(
        JSON.stringify({
          ok: true,
          processes: [{ ProcessId: 'abc', ExecutablePath: APP, CommandLine: 'x' }]
        })
      )
    ).toThrow(DesktopE2EError);
  });

  test('parses valid process list', () => {
    const procs = parseProcessQueryJson(
      JSON.stringify({
        ok: true,
        processes: [
          {
            ProcessId: 42,
            ExecutablePath: APP,
            CommandLine: `"${APP}" note.md ${buildSessionArg(SESSION)}`,
            CreationDate: '2026-01-01T00:00:00.0000000Z'
          }
        ]
      })
    );
    expect(procs).toHaveLength(1);
    expect(procs[0].pid).toBe(42);
    expect(procs[0].executablePath).toBe(APP);
    expect(procs[0].commandLine).toContain(buildSessionArg(SESSION));
  });

  test('normalizes PowerShell 5.1 single-object processes field to a one-item array', () => {
    // PS 5.1 ConvertTo-Json often collapses a single-element array property.
    const procs = parseProcessQueryJson(
      JSON.stringify({
        ok: true,
        processes: {
          ProcessId: 99,
          ExecutablePath: APP,
          CommandLine: `"${APP}" ${buildSessionArg(SESSION)}`
        }
      })
    );
    expect(procs).toHaveLength(1);
    expect(procs[0].pid).toBe(99);
  });
});

describe('desktop-processes listVelloraProcesses fail-closed', () => {
  test('returns empty array when PowerShell reports success with no processes', () => {
    const execFileSyncFn = vi.fn(() =>
      JSON.stringify({ ok: true, processes: [] })
    );
    const procs = listVelloraProcesses({ execFileSyncFn });
    expect(procs).toEqual([]);
    expect(execFileSyncFn).toHaveBeenCalled();
    const args = execFileSyncFn.mock.calls[0];
    expect(args[0]).toBe('powershell.exe');
    expect(args[1]).toEqual(
      expect.arrayContaining(['-NoProfile', '-NonInteractive', '-File'])
    );
  });

  test('throws when PowerShell/CIM execution fails (does not return empty array)', () => {
    const err = new Error('cim failed');
    err.status = 1;
    err.stderr = 'Access denied';
    const execFileSyncFn = vi.fn(() => {
      throw err;
    });
    expect(() => listVelloraProcesses({ execFileSyncFn })).toThrow(DesktopE2EError);
    expect(() => listVelloraProcesses({ execFileSyncFn })).toThrow(/无法确认 Vellora 进程状态/);
  });

  test('throws when PowerShell cannot start', () => {
    const err = new Error('not found');
    err.code = 'ENOENT';
    const execFileSyncFn = vi.fn(() => {
      throw err;
    });
    expect(() => listVelloraProcesses({ execFileSyncFn })).toThrow(/powershell/i);
  });

  test('throws when stdout is illegal JSON', () => {
    const execFileSyncFn = vi.fn(() => '<<<not json>>>');
    expect(() => listVelloraProcesses({ execFileSyncFn })).toThrow(DesktopE2EError);
  });
});

describe('desktop-processes ownership selection', () => {
  const baseCmd = (session, exe = APP) =>
    `"${exe}" "C:\\tmp\\source.md" ${buildSessionArg(session)}`;

  test('same path with this session token is owned', () => {
    const pids = selectOwnedTestVellora(
      [
        {
          pid: 100,
          executablePath: APP,
          commandLine: baseCmd(SESSION)
        }
      ],
      { appBinary: APP, session: SESSION }
    );
    expect(pids).toEqual([100]);
  });

  test('same path without session token is not owned', () => {
    const pids = selectOwnedTestVellora(
      [
        {
          pid: 101,
          executablePath: APP,
          commandLine: `"${APP}" C:\\docs\\user.md`
        }
      ],
      { appBinary: APP, session: SESSION }
    );
    expect(pids).toEqual([]);
  });

  test('same path with a different session token is not owned', () => {
    const pids = selectOwnedTestVellora(
      [
        {
          pid: 102,
          executablePath: APP,
          commandLine: baseCmd(OTHER_SESSION)
        }
      ],
      { appBinary: APP, session: SESSION }
    );
    expect(pids).toEqual([]);
  });

  test('same token but different executable path is not owned', () => {
    const otherExe = 'C:\\Other\\vellora.exe';
    const pids = selectOwnedTestVellora(
      [
        {
          pid: 103,
          executablePath: otherExe,
          commandLine: baseCmd(SESSION, otherExe)
        }
      ],
      { appBinary: APP, session: SESSION }
    );
    expect(pids).toEqual([]);
  });

  test('token prefix-only or token embedded in a file path is not owned', () => {
    // Prefix of the flag only
    expect(
      commandLineHasSession(`"${APP}" --vellora-e2e-session=${SESSION.slice(0, 8)}`, SESSION)
    ).toBe(false);

    // Token appears inside a normal file path argument, not as the launch flag
    const pathEmbed = `"${APP}" "C:\\docs\\--vellora-e2e-session=${SESSION}.md"`;
    expect(commandLineHasSession(pathEmbed, SESSION)).toBe(false);
    expect(
      selectOwnedTestVellora(
        [{ pid: 104, executablePath: APP, commandLine: pathEmbed }],
        { appBinary: APP, session: SESSION }
      )
    ).toEqual([]);

    // Partial flag without full UUID value as discrete arg
    const partial = `"${APP}" --vellora-e2e-session=${SESSION}extra`;
    expect(commandLineHasSession(partial, SESSION)).toBe(false);
  });

  test('invalid pid / missing command line / missing executable path are excluded', () => {
    const pids = selectOwnedTestVellora(
      [
        { pid: 0, executablePath: APP, commandLine: baseCmd(SESSION) },
        { pid: -1, executablePath: APP, commandLine: baseCmd(SESSION) },
        { pid: 200, executablePath: null, commandLine: baseCmd(SESSION) },
        { pid: 201, executablePath: APP, commandLine: null },
        { pid: 202, executablePath: APP },
        { pid: 203, executablePath: APP, commandLine: baseCmd(SESSION) }
      ],
      { appBinary: APP, session: SESSION }
    );
    expect(pids).toEqual([203]);
  });

  test('three-class mix only keeps this-session process', () => {
    const pids = selectOwnedTestVellora(
      [
        {
          pid: 1,
          executablePath: APP,
          commandLine: `"${APP}" user.md`
        },
        {
          pid: 2,
          executablePath: APP,
          commandLine: baseCmd(OTHER_SESSION)
        },
        {
          pid: 3,
          executablePath: APP,
          commandLine: baseCmd(SESSION)
        }
      ],
      { appBinary: APP, session: SESSION }
    );
    expect(pids).toEqual([3]);
  });

  test('path comparison is case-insensitive on Windows-style paths', () => {
    const pids = selectOwnedTestVellora(
      [
        {
          pid: 9,
          executablePath: APP.toUpperCase(),
          commandLine: baseCmd(SESSION)
        }
      ],
      { appBinary: APP.toLowerCase(), session: SESSION }
    );
    expect(pids).toEqual([9]);
  });
});

describe('desktop-processes assertNoPreexistingVellora', () => {
  test('continues only when query succeeds with empty list', () => {
    expect(() => assertNoPreexistingVellora(() => [])).not.toThrow();
  });

  test('throws when processes exist', () => {
    expect(() =>
      assertNoPreexistingVellora(() => [
        { pid: 1, executablePath: APP, commandLine: 'x', creationDate: null }
      ])
    ).toThrow(/已有 Vellora/);
  });

  test('propagates query failures (does not treat as empty)', () => {
    expect(() =>
      assertNoPreexistingVellora(() => {
        throw new DesktopE2EError('无法确认 Vellora 进程状态：CIM 失败。');
      })
    ).toThrow(/无法确认 Vellora 进程状态/);
  });
});

describe('desktop-processes cleanup', () => {
  test('query failure during cleanup does not taskkill any Vellora PID', () => {
    const killed = [];
    const controller = createCleanupController({
      listVelloraProcesses: () => {
        throw new DesktopE2EError('无法确认 Vellora 进程状态：模拟失败。');
      },
      killPidTree: (pid) => {
        killed.push(pid);
        return { ok: true };
      },
      logError: () => undefined,
      rmSync: () => undefined
    });

    const result = controller.cleanup({
      wdioPid: 10,
      driverPid: 11,
      appBinary: APP,
      session: SESSION,
      fixtureDir: null
    });

    expect(result.cleanupFailed).toBe(true);
    expect(killed).toEqual([10, 11]);
    expect(killed).not.toContain(999);
  });

  test('cleanup only kills session-owned Vellora after re-query', () => {
    const killed = [];
    const alive = new Set([3]);
    const all = [
      {
        pid: 3,
        executablePath: APP,
        commandLine: `"${APP}" t.md ${buildSessionArg(SESSION)}`,
        creationDate: null
      },
      {
        pid: 4,
        executablePath: 'C:\\Other\\vellora.exe',
        commandLine: `"C:\\Other\\vellora.exe" t.md ${buildSessionArg(SESSION)}`,
        creationDate: null
      }
    ];
    const controller = createCleanupController({
      listVelloraProcesses: () => all.filter((p) => p.pid === 4 || alive.has(p.pid)),
      killPidTree: (pid) => {
        killed.push(pid);
        alive.delete(pid);
        return { ok: true };
      },
      logError: () => undefined,
      rmSync: () => undefined
    });

    const result = controller.cleanup({
      wdioPid: 10,
      driverPid: 11,
      appBinary: APP,
      session: SESSION,
      fixtureDir: null
    });

    expect(result.cleanupFailed).toBe(false);
    expect(killed).toEqual([10, 11, 3]);
  });

  test('same release path without session token fails cleanup without killing it', () => {
    const killed = [];
    // Owned goes away after kill; unowned same-path remains (must not be killed, must fail run).
    const alive = new Set([1, 3]);
    const controller = createCleanupController({
      listVelloraProcesses: () =>
        [
          {
            pid: 1,
            executablePath: APP,
            commandLine: `"${APP}" user.md`,
            creationDate: null
          },
          {
            pid: 3,
            executablePath: APP,
            commandLine: `"${APP}" t.md ${buildSessionArg(SESSION)}`,
            creationDate: null
          }
        ].filter((p) => alive.has(p.pid)),
      killPidTree: (pid) => {
        killed.push(pid);
        if (pid === 3) alive.delete(3);
        return { ok: true };
      },
      logError: () => undefined,
      rmSync: () => undefined
    });

    const result = controller.cleanup({
      wdioPid: 10,
      driverPid: 11,
      appBinary: APP,
      session: SESSION,
      fixtureDir: null
    });

    expect(result.cleanupFailed).toBe(true);
    expect(killed).toEqual([10, 11, 3]);
    expect(killed).not.toContain(1);
  });

  test('taskkill failure that leaves owned process alive marks cleanup failed', () => {
    const logs = [];
    let listCalls = 0;
    // Process remains visible after failed taskkill.
    const controller = createCleanupController({
      listVelloraProcesses: () => {
        listCalls += 1;
        return [
          {
            pid: 3,
            executablePath: APP,
            commandLine: `"${APP}" t.md ${buildSessionArg(SESSION)}`,
            creationDate: null
          }
        ];
      },
      killPidTree: (pid) => {
        if (pid === 3) return { ok: false, status: 5 };
        return { ok: true };
      },
      logError: (msg) => logs.push(msg),
      rmSync: () => undefined
    });

    const result = controller.cleanup({
      wdioPid: 10,
      driverPid: 11,
      appBinary: APP,
      session: SESSION,
      fixtureDir: null
    });

    expect(result.cleanupFailed).toBe(true);
    expect(listCalls).toBeGreaterThanOrEqual(2);
    expect(logs.some((m) => /CLEANUP FAILED|会话令牌/i.test(m))).toBe(true);
  });

  test('taskkill non-zero but process gone does not fail cleanup', () => {
    const alive = new Set([3]);
    const controller = createCleanupController({
      listVelloraProcesses: () =>
        alive.has(3)
          ? [
              {
                pid: 3,
                executablePath: APP,
                commandLine: `"${APP}" t.md ${buildSessionArg(SESSION)}`,
                creationDate: null
              }
            ]
          : [],
      killPidTree: (pid) => {
        alive.delete(pid);
        if (pid === 3) return { ok: false, status: 1 };
        return { ok: true };
      },
      logError: () => undefined,
      rmSync: () => undefined
    });

    const result = controller.cleanup({
      wdioPid: null,
      driverPid: null,
      appBinary: APP,
      session: SESSION,
      fixtureDir: null
    });

    expect(result.cleanupFailed).toBe(false);
  });

  test('cleanup is idempotent on repeated calls', () => {
    const killed = [];
    let listCalls = 0;
    const alive = new Set([3]);
    const controller = createCleanupController({
      listVelloraProcesses: () => {
        listCalls += 1;
        if (!alive.has(3)) return [];
        return [
          {
            pid: 3,
            executablePath: APP,
            commandLine: `"${APP}" t.md ${buildSessionArg(SESSION)}`,
            creationDate: null
          }
        ];
      },
      killPidTree: (pid) => {
        killed.push(pid);
        alive.delete(pid);
        return { ok: true };
      },
      logError: () => undefined,
      rmSync: () => undefined
    });

    const state = {
      wdioPid: 10,
      driverPid: 11,
      appBinary: APP,
      session: SESSION,
      fixtureDir: null
    };

    controller.cleanup(state);
    controller.cleanup(state);
    controller.cleanup(state);

    // First cleanup: list + post-kill re-query. Subsequent cleanups no-op.
    expect(listCalls).toBe(2);
    expect(killed).toEqual([10, 11, 3]);
    expect(controller.cleaned).toBe(true);
    expect(controller.cleanupFailed).toBe(false);
  });
});
