import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, test, vi, beforeEach, beforeAll, afterAll } from 'vitest';

const { mockShowMessageBox, mockHandlers } = vi.hoisted(() => {
  return {
    mockShowMessageBox: vi.fn(),
    mockHandlers: new Map<string, Function>()
  };
});

vi.mock('electron', () => {
  return {
    app: {
      getPath: vi.fn().mockImplementation((name) => {
        const tempBase = join(tmpdir(), 'md-viewer-tests');
        if (name === 'userData') return join(tempBase, 'userdata');
        if (name === 'home') return join(tempBase, 'home');
        if (name === 'documents') return join(tempBase, 'documents');
        if (name === 'desktop') return join(tempBase, 'desktop');
        return tempBase;
      })
    },
    dialog: {
      showMessageBox: mockShowMessageBox
    },
    ipcMain: {
      handle: vi.fn().mockImplementation((channel, handler) => {
        mockHandlers.set(channel, handler);
      }),
      removeHandler: vi.fn().mockImplementation((channel) => {
        mockHandlers.delete(channel);
      })
    },
    shell: {
      openPath: vi.fn()
    },
    BrowserWindow: vi.fn()
  };
});

import { authorizeMarkdownOpenRequest, registerIpcHandlers } from './ipc';
import { IPC_CHANNELS } from '../shared/ipcChannels';


async function createAuthorizationFixture(): Promise<{
  markdownPath: string;
  textPath: string;
  missingPath: string;
}> {
  const dir = join(tmpdir(), `md-viewer-ipc-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  const markdownPath = join(dir, '系统打开.md');
  const textPath = join(dir, 'notes.txt');
  const missingPath = join(dir, 'missing.md');
  await writeFile(markdownPath, '# 系统打开', 'utf8');
  await writeFile(textPath, 'not markdown', 'utf8');
  return { markdownPath, textPath, missingPath };
}

describe('system Markdown open authorization', () => {
  test('authorizes existing Markdown files passed by the operating system', async () => {
    const { markdownPath } = await createAuthorizationFixture();

    expect(authorizeMarkdownOpenRequest(markdownPath)).toBe(true);
  });

  test('does not authorize unsupported, missing, or blank system open paths', async () => {
    const { textPath, missingPath } = await createAuthorizationFixture();

    expect(authorizeMarkdownOpenRequest(textPath)).toBe(false);
    expect(authorizeMarkdownOpenRequest(missingPath)).toBe(false);
    expect(authorizeMarkdownOpenRequest('')).toBe(false);
    expect(authorizeMarkdownOpenRequest(null)).toBe(false);
  });
});

async function createUnauthorizedFile(suffix: string): Promise<string> {
  const unauthorizedDir = join(process.cwd(), `unauthorized_test_dir_${suffix}`);
  await mkdir(unauthorizedDir, { recursive: true });
  const unauthorizedPath = join(unauthorizedDir, 'notes.md');
  await writeFile(unauthorizedPath, '# 敏感外部文件', 'utf8');
  return unauthorizedPath;
}

async function cleanUnauthorizedFile(suffix: string) {
  const unauthorizedDir = join(process.cwd(), `unauthorized_test_dir_${suffix}`);
  try {
    await rm(unauthorizedDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

describe('IPC OPEN_MARKDOWN_BY_PATH security validation', () => {
  let mockWindow: any;

  beforeEach(() => {
    mockWindow = {
      on: vi.fn()
    } as any;
    mockHandlers.clear();
    mockShowMessageBox.mockReset();
    registerIpcHandlers(mockWindow);
  });

  test('rejects unauthorized paths and blocks fake isDropped true parameter', async () => {
    const suffix = `case1_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const unauthorizedPath = await createUnauthorizedFile(suffix);
    try {
      const handler = mockHandlers.get(IPC_CHANNELS.OPEN_MARKDOWN_BY_PATH);
      expect(handler).toBeDefined();

      // 用户在安全提示中点击“取消” (showMessageBox 返回 response: 0)
      mockShowMessageBox.mockResolvedValue({ response: 0 });

      // 攻击者尝试通过传入额外的布尔值参数 `true`（模拟原有的 isDropped）来绕过主进程授权
      // 在旧逻辑中，这会直接跳过 isFileAuthorized，导致越权读取
      const result = await handler!({} as any, unauthorizedPath, true);

      expect(result.ok).toBe(false);
      expect(result.code).toBe('READ_FAILED'); // 由于授权拦截并遭取消，应当返回 READ_FAILED
      expect(mockShowMessageBox).toHaveBeenCalledTimes(1); // 应弹出安全确认框
    } finally {
      await cleanUnauthorizedFile(suffix);
    }
  });

  test('allows unauthorized paths after explicit human dialog approval', async () => {
    const suffix = `case2_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const unauthorizedPath = await createUnauthorizedFile(suffix);
    try {
      const handler = mockHandlers.get(IPC_CHANNELS.OPEN_MARKDOWN_BY_PATH);
      expect(handler).toBeDefined();

      // 用户在安全提示中点击“授权并打开” (showMessageBox 返回 response: 1)
      mockShowMessageBox.mockResolvedValue({ response: 1 });

      const result = await handler!({} as any, unauthorizedPath);

      // 授权通过后，系统会尝试读取该文件。因为该文件真实存在，它应该成功读取并返回 ok: true
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.content).toBe('# 敏感外部文件');
      expect(mockShowMessageBox).toHaveBeenCalledTimes(1);
    } finally {
      await cleanUnauthorizedFile(suffix);
    }
  });

  test('does not prompt authorization for files inside test temporary directory', async () => {
    // 创建一个位于系统临时目录 (os.tmpdir) 的临时测试文件
    const suffix = `test_temp_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const testTempDir = join(tmpdir(), `test_temp_ipc_${suffix}`);
    await mkdir(testTempDir, { recursive: true });
    const tempFilePath = join(testTempDir, 'temp_notes.md');
    await writeFile(tempFilePath, '# 临时测试文件', 'utf8');

    try {
      const handler = mockHandlers.get(IPC_CHANNELS.OPEN_MARKDOWN_BY_PATH);
      expect(handler).toBeDefined();

      // 在测试模式下，临时目录文件应该无需授权框直接通过
      const result = await handler!({} as any, tempFilePath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.content).toBe('# 临时测试文件');
      // 应该没有弹出过 showMessageBox
      expect(mockShowMessageBox).toHaveBeenCalledTimes(0);
    } finally {
      try {
        await rm(testTempDir, { recursive: true, force: true });
      } catch {}
    }
  });
});
