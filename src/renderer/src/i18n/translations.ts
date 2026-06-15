export type I18nMessages = typeof zh;

const zh = {
  app: {
    title: 'Markdown查看器',
    emptyTitle: '未打开文件',
    emptyHint: '请选择 .md 或 .markdown 文件。',
    openFile: '打开文件',
    openFolder: '打开文件夹',
    recentHeading: '最近打开',
    fileNotExist: '文件不存在',
    loading: '正在打开文件',
    errorTitle: '打开失败',
    reselect: '重新选择',
    documentEmpty: '文件为空',
    parseError: 'Markdown 解析失败，请切换源码编辑修复。',
    imageMissing: (source: string) => `图片缺失：${source}`
  },
  fileInfo: {
    title: '文件详细信息',
    fileName: '文件名',
    filePath: '绝对路径',
    fileSize: '大小',
    wordCount: '字数统计',
    charCount: '字符数',
    modifiedAt: '更新时间',
    words: (n: number) => `${n} 字`,
    bytes: (size: number) => {
      if (size < 1024) return `${size} B`;
      if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
      return `${(size / (1024 * 1024)).toFixed(1)} MB`;
    },
    modifiedLabel: (date: string) => `修改：${date}`
  },
  statusBar: {
    noFile: '未打开文件',
    words: (n: number) => `${n} 字`
  },
  workspace: {
    tab: '工作区',
    heading: '工作区',
    noFolder: '未打开文件夹',
    loading: '正在读取文件夹',
    filterPlaceholder: '筛选文件',
    filterAria: '筛选文件',
    noMatch: '无匹配文件',
    truncated: (limit: number) => `已限制显示 ${limit} 个 Markdown 文件`
  },
  outline: {
    tab: '大纲',
    heading: '大纲',
    empty: '无大纲'
  },
  sidebar: {
    ariaLabel: '侧栏',
    ariaView: '侧栏视图'
  },
  search: {
    placeholder: '搜索',
    ariaLabel: '搜索当前文档',
    noResults: '无结果',
    count: (current: number, total: number) => `${current + 1}/${total}`,
    prevAria: '上一个结果',
    prevTitle: '上一个结果',
    nextAria: '下一个结果',
    nextTitle: '下一个结果',
    closeAria: '关闭搜索',
    closeTitle: '关闭搜索'
  },
  commandPalette: {
    placeholder: '输入命令快速执行操作...',
    noMatch: '未匹配到任何命令。',
    items: {
      openFile: '打开 Markdown 文件',
      openFolder: '打开工作区文件夹',
      save: '保存当前更改',
      editRead: '返回阅读模式',
      editSource: '进入源码编辑',
      themeDark: '切换到深色夜间主题',
      themeLight: '切换到浅色明亮主题',
      fileInfo: '查看文档元数据详情',
      exportPdf: '导出 PDF',
      settings: '系统安全诊断与设置',
      recent: '浏览最近打开的文件/文件夹',
      closeDoc: '关闭当前文档'
    }
  },
  settings: {
    title: '设置与安全诊断',
    theme: '外观主题',
    language: 'Language / 语言',
    langEn: 'English',
    langZh: '中文',
    themeLight: '浅色',
    themeDark: '深色',
    securityReport: '安全环境诊断报告',
    contextIsolation: '上下文隔离 (Context Isolation)',
    nodeIntegration: 'Node.js 集成 (Node Integration)',
    sandbox: '沙盒化 (Sandbox)',
    webSecurity: '网页安全限制 (Web Security)',
    webviewTag: 'Webview 标签 (Webview Tag)',
    enabled: '已启用',
    disabled: '已禁用',
    ipcWhitelist: 'IPC 信道白名单',
    notLoaded: '未加载信道信息',
    loadingDiagnostics: '获取诊断报告中...'
  },
  recent: {
    heading: '最近打开',
    empty: '暂无任何最近打开的文件或文件夹记录。',
    expired: '已失效'
  },
  externalLink: {
    title: '安全提示',
    message: '您即将访问外部链接，确认离开此应用程序吗？',
    cancel: '取消',
    confirm: '继续访问'
  },
  pdf: {
    cancelled: '已取消导出。',
    failed: 'PDF 导出失败。'
  },
  imageLightbox: {
    alt: '图片预览'
  },
  save: {
    saving: '保存中...',
    saved: '已保存',
    error: '保存失败'
  }
};

const en: I18nMessages = {
  app: {
    title: 'Markdown Viewer',
    emptyTitle: 'No file opened',
    emptyHint: 'Please select a .md or .markdown file.',
    openFile: 'Open File',
    openFolder: 'Open Folder',
    recentHeading: 'Recent',
    fileNotExist: 'File does not exist',
    loading: 'Opening file…',
    errorTitle: 'Open Failed',
    reselect: 'Reselect',
    documentEmpty: 'File is empty',
    parseError: 'Markdown parse error. Switch to source edit to fix.',
    imageMissing: (source: string) => `Image missing: ${source}`
  },
  fileInfo: {
    title: 'File Details',
    fileName: 'File Name',
    filePath: 'Absolute Path',
    fileSize: 'Size',
    wordCount: 'Word Count',
    charCount: 'Character Count',
    modifiedAt: 'Last Modified',
    words: (n: number) => `${n} words`,
    bytes: (size: number) => {
      if (size < 1024) return `${size} B`;
      if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
      return `${(size / (1024 * 1024)).toFixed(1)} MB`;
    },
    modifiedLabel: (date: string) => `Modified: ${date}`
  },
  statusBar: {
    noFile: 'No file opened',
    words: (n: number) => `${n} words`
  },
  workspace: {
    tab: 'Workspace',
    heading: 'Workspace',
    noFolder: 'No folder opened',
    loading: 'Reading folder…',
    filterPlaceholder: 'Filter files',
    filterAria: 'Filter files',
    noMatch: 'No matching files',
    truncated: (limit: number) => `Display limited to ${limit} Markdown files`
  },
  outline: {
    tab: 'Outline',
    heading: 'Outline',
    empty: 'No outline'
  },
  sidebar: {
    ariaLabel: 'Sidebar',
    ariaView: 'Sidebar view'
  },
  search: {
    placeholder: 'Search',
    ariaLabel: 'Search current document',
    noResults: 'No results',
    count: (current: number, total: number) => `${current + 1}/${total}`,
    prevAria: 'Previous result',
    prevTitle: 'Previous result',
    nextAria: 'Next result',
    nextTitle: 'Next result',
    closeAria: 'Close search',
    closeTitle: 'Close search'
  },
  commandPalette: {
    placeholder: 'Type a command…',
    noMatch: 'No matching commands.',
    items: {
      openFile: 'Open Markdown File',
      openFolder: 'Open Workspace Folder',
      save: 'Save Current Changes',
      editRead: 'Switch to Read Mode',
      editSource: 'Switch to Source Edit',
      themeDark: 'Switch to Dark Theme',
      themeLight: 'Switch to Light Theme',
      fileInfo: 'View Document Metadata',
      exportPdf: 'Export PDF',
      settings: 'System Security Diagnostics & Settings',
      recent: 'Browse Recently Opened Files/Folders',
      closeDoc: 'Close Current Document'
    }
  },
  settings: {
    title: 'Settings & Security Diagnostics',
    theme: 'Appearance',
    language: 'Language / 语言',
    langEn: 'English',
    langZh: '中文',
    themeLight: 'Light',
    themeDark: 'Dark',
    securityReport: 'Security Diagnostics Report',
    contextIsolation: 'Context Isolation',
    nodeIntegration: 'Node Integration',
    sandbox: 'Sandbox',
    webSecurity: 'Web Security',
    webviewTag: 'Webview Tag',
    enabled: 'Enabled',
    disabled: 'Disabled',
    ipcWhitelist: 'IPC Channel Whitelist',
    notLoaded: 'Channel information not loaded',
    loadingDiagnostics: 'Loading diagnostics…'
  },
  recent: {
    heading: 'Recently Opened',
    empty: 'No recently opened files or folders.',
    expired: 'Unavailable'
  },
  externalLink: {
    title: 'Security Notice',
    message: 'You are about to visit an external link. Leave this application?',
    cancel: 'Cancel',
    confirm: 'Continue'
  },
  pdf: {
    cancelled: 'Export cancelled.',
    failed: 'PDF export failed.'
  },
  imageLightbox: {
    alt: 'Image preview'
  },
  save: {
    saving: 'Saving…',
    saved: 'Saved',
    error: 'Save failed'
  }
};

export { zh, en };
