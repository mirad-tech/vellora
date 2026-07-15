/**
 * Browser-mode E2E: Vite + mocked Tauri IPC.
 * Validates UI flows without WebView2/msedgedriver.
 */

const sampleDoc = {
  path: 'C:\\e2e\\sample.md',
  name: 'sample.md',
  content: '# 标题一\n\n正文搜索词 hello\n\n## 标题二\n\n[外链](https://example.com/path)\n',
  modifiedAt: Date.now(),
  size: 80
};

let savedContent = sampleDoc.content;

async function installMocks() {
  await browser.execute((doc) => {
    const state = {
      document: { ...doc },
      saved: doc.content
    };

    const handler = async (cmd, args = {}) => {
      if (cmd === 'get_initial_document') {
        return { ok: false, code: 'NO_INITIAL', message: '没有初始文档。' };
      }
      if (cmd === 'set_unsaved_changes' || cmd === 'confirm_close') {
        return { ok: true };
      }
      if (cmd === 'choose_markdown_file' || cmd === 'open_markdown_file') {
        return {
          ok: true,
          document: {
            ...state.document,
            content: state.saved,
            modifiedAt: Date.now()
          }
        };
      }
      if (cmd === 'save_markdown_file') {
        state.saved = args.content ?? state.saved;
        state.document = {
          ...state.document,
          content: state.saved,
          modifiedAt: Date.now()
        };
        // expose for Node-side assertion via browser.execute later
        window.__e2eSavedContent = state.saved;
        return { ok: true, document: state.document };
      }
      if (cmd === 'resolve_local_image') {
        return {
          ok: false,
          code: 'IMAGE_NOT_FOUND',
          message: '图片不存在或已被移动。'
        };
      }
      if (cmd === 'inspect_markdown_link') {
        const href = args.href ?? '';
        if (href.startsWith('http://') || href.startsWith('https://')) {
          return {
            ok: true,
            action: 'external',
            url: href.endsWith('/') ? href : `${href}/`
          };
        }
        return {
          ok: false,
          code: 'UNSUPPORTED_LINK',
          message: '只能打开 Markdown 链接或安全外部链接。'
        };
      }
      if (cmd === 'open_external_url') {
        window.__e2eOpenedExternal = args.url;
        return { ok: true };
      }
      return { ok: false, code: 'UNKNOWN', message: `unmocked ${cmd}` };
    };

    // Mock both modern and legacy Tauri bridges used by @tauri-apps/api
    window.__TAURI_INTERNALS__ = {
      invoke: handler,
      transformCallback: (cb) => cb,
      unregisterCallback: () => undefined,
      plugins: {}
    };
    window.__TAURI__ = {
      core: { invoke: handler },
      event: {
        listen: async () => () => undefined
      }
    };

    // Drag-drop / single-instance listeners become no-ops under browser mode
    return true;
  }, sampleDoc);
}

async function openSample() {
  const openBtn = await $('[data-testid="btn-open"]');
  await openBtn.waitForDisplayed({ timeout: 20000 });
  await openBtn.click();
  const discard = await $('[data-testid="discard-modal"]');
  if (await discard.isDisplayed().catch(() => false)) {
    await $('[data-testid="discard-confirm"]').click();
    await openBtn.click();
  }
  await $('[data-testid="markdown-body"]').waitForDisplayed({ timeout: 15000 });
}

describe('Vellora 2.0 browser-mode smoke', () => {
  before(async () => {
    await browser.url('/');
    await installMocks();
    // Reload so React mounts with mocks already present
    await browser.url('/');
    await installMocks();
    await $('[data-testid="app-shell"]').waitForDisplayed({ timeout: 20000 });
  });

  beforeEach(async () => {
    savedContent = sampleDoc.content;
    await browser.url('/');
    await installMocks();
    await $('[data-testid="app-shell"]').waitForDisplayed({ timeout: 15000 });
  });

  it('empty launch shows empty state', async () => {
    const empty = await $('[data-testid="empty-state"]');
    await empty.waitForDisplayed();
    expect(await empty.getText()).toContain('未打开文件');
  });

  it('opens a file and renders markdown', async () => {
    await openSample();
    expect(await $('[data-testid="markdown-body"]').getText()).toContain('标题一');
  });

  it('switches to edit mode and edits source', async () => {
    await openSample();
    await $('[data-testid="btn-edit"]').click();
    const editor = await $('[data-testid="source-editor"]');
    await editor.waitForDisplayed();
    await editor.setValue('# 新标题\n\n编辑内容');
    await $('[data-testid="btn-read"]').click();
    expect(await $('[data-testid="markdown-body"]').getText()).toContain('新标题');
  });

  it('save button works after edit', async () => {
    await openSample();
    await $('[data-testid="btn-edit"]').click();
    await (await $('[data-testid="source-editor"]')).setValue('# 保存测试\n');
    const save = await $('[data-testid="btn-save"]');
    await save.click();
    await browser.waitUntil(
      async () => {
        const label = await save.getText();
        return label === '已保存' || label === '保存';
      },
      { timeout: 10000 }
    );
    const content = await browser.execute(() => window.__e2eSavedContent);
    expect(content).toContain('保存测试');
  });

  it('prompts discard when opening while dirty', async () => {
    await openSample();
    await $('[data-testid="btn-edit"]').click();
    await (await $('[data-testid="source-editor"]')).setValue('dirty content');
    await $('[data-testid="btn-open"]').click();
    const modal = await $('[data-testid="discard-modal"]');
    await modal.waitForDisplayed({ timeout: 5000 });
    await $('[data-testid="discard-cancel"]').click();
    await modal.waitForDisplayed({ reverse: true, timeout: 5000 });
  });

  it('document search finds matches', async () => {
    await openSample();
    await $('[data-testid="btn-search"]').click();
    const input = await $('[data-testid="search-input"]');
    await input.setValue('搜索词');
    const count = await $('[data-testid="search-count"]');
    await browser.waitUntil(async () => (await count.getText()).includes('/'), {
      timeout: 5000
    });
    expect(await count.getText()).toMatch(/\d+\/\d+/);
  });

  it('outline lists headings', async () => {
    await openSample();
    await $('[data-testid="btn-outline"]').click();
    await $('[data-testid="outline-panel"]').waitForDisplayed();
    const items = await $$('[data-testid="outline-item"]');
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(await items[0].getText()).toContain('标题');
  });

  it('external link shows confirm modal', async () => {
    await openSample();
    const link = await $('[data-testid="markdown-body"] a');
    await link.click();
    const modal = await $('[data-testid="external-link-modal"]');
    await modal.waitForDisplayed({ timeout: 5000 });
    await $('[data-testid="external-cancel"]').click();
    await modal.waitForDisplayed({ reverse: true, timeout: 5000 });
  });
});
