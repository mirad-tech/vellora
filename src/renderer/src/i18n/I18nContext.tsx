import { createContext, useCallback, useEffect, useState, type ReactNode } from 'react';
import { en, zh } from './translations';

export type Lang = 'zh' | 'en';
export type I18nMessages = typeof zh;

const STORAGE_KEY = 'md-viewer-lang';

function detectLang(): Lang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'zh' || stored === 'en') return stored;
  } catch {
    // localStorage may be unavailable
  }

  try {
    const navLang = navigator.language.toLowerCase();
    if (navLang.startsWith('zh')) return 'zh';
  } catch {
    // navigator.language may be unavailable
  }

  return 'en';
}

const messages: Record<Lang, I18nMessages> = { zh, en };

export const I18nContext = createContext<{
  lang: Lang;
  t: I18nMessages;
  setLang: (lang: Lang) => void;
}>({
  lang: 'en',
  t: en,
  setLang: () => {}
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectLang);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore
    }
    // Sync to native menu
    try {
      window.mdViewer.setLanguage(next);
    } catch {
      // preload API may not be available in test
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    document.title = messages[lang].app.title;
    // Sync native menu on startup
    try {
      window.mdViewer.setLanguage(lang);
    } catch {
      // preload API may not be available in test
    }
  }, [lang]);

  const t = messages[lang];

  return (
    <I18nContext.Provider value={{ lang, t, setLang }}>
      {children}
    </I18nContext.Provider>
  );
}
