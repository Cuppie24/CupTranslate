import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { enable as enableAutostart, disable as disableAutostart, isEnabled as isAutostartEnabled } from "@tauri-apps/plugin-autostart";
import "./TranslatePage.css";
import {
  Sun, Moon, X, Copy, Check, Loader2,
  Settings as SettingsIcon, ArrowLeft, Key, Keyboard, RefreshCw, ArrowRightLeft, Pin, Power,
  ChevronDown, Search,
} from "lucide-react";

const FALLBACK_LANGUAGES = [
  { language: 'en', name: 'English' },
  { language: 'es', name: 'Spanish' },
  { language: 'fr', name: 'French' },
  { language: 'de', name: 'German' },
  { language: 'ja', name: 'Japanese' },
  { language: 'zh', name: 'Chinese' },
  { language: 'pt', name: 'Portuguese' },
  { language: 'it', name: 'Italian' },
  { language: 'ko', name: 'Korean' },
  { language: 'ru', name: 'Russian' },
  { language: 'ar', name: 'Arabic' },
];

const DEFAULT_HOTKEY = 'Ctrl+Shift+Space';
const MODIFIER_CODES = new Set([
  'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight',
  'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight',
]);

interface TranslateResult {
  translated_text: string;
  detected_language: string | null;
}

interface DetectResult {
  language: string;
  confidence: number | null;
}

interface LanguageInfo {
  language: string;
  name: string;
}

function formatHotkey(accelerator: string): string {
  return accelerator.replace(/ControlOrMeta|CommandOrControl/g, 'Ctrl').split('+').join(' + ');
}

interface ComboTheme {
  paper: string;
  paperSub: string;
  border: string;
  ink: string;
  inkFaint: string;
  hoverBg: string;
  accent: string;
}

interface LanguageComboboxProps {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  languages: LanguageInfo[];
  includeAutoDetect?: boolean;
  showAsAuto?: boolean;
  theme: ComboTheme;
}

// Notion-style searchable dropdown: a trigger button plus, once opened, a
// panel (search box + filtered rows). The panel lives in normal document
// flow rather than floating — this popup window auto-sizes to its content's
// offsetHeight (see the ResizeObserver effect above), so an absolutely
// positioned overlay would render outside the actual OS window bounds.
function LanguageCombobox({
  value, onChange, placeholder, languages, includeAutoDetect, showAsAuto, theme,
}: LanguageComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const options = useMemo(() => {
    const base = includeAutoDetect ? [{ language: 'auto', name: 'Autodetect' }, ...languages] : languages;
    const q = query.trim().toLowerCase();
    if (!q) return base;
    return base.filter(l => l.name.toLowerCase().includes(q) || l.language.toLowerCase().includes(q));
  }, [languages, includeAutoDetect, query]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  useEffect(() => {
    if (open) {
      searchRef.current?.focus();
    } else {
      setQuery('');
      setActive(0);
    }
  }, [open]);

  const label = showAsAuto
    ? 'Auto'
    : languages.find(l => l.language === value)?.name
      ?? (includeAutoDetect && value === 'auto' ? 'Autodetect' : '');

  const commit = (lang: string) => {
    onChange(lang);
    setOpen(false);
  };

  const onSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, options.length - 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const opt = options[active];
      if (opt) commit(opt.language);
    }
  };

  return (
    <div className="tp-combo" ref={rootRef}>
      <button
        type="button"
        className="tp-combo-trigger"
        style={{ background: theme.paperSub, border: `1px solid ${open ? theme.accent : theme.border}`, color: label ? theme.ink : theme.inkFaint }}
        onClick={() => setOpen(o => !o)}
      >
        <span className="tp-combo-value">{label || placeholder}</span>
        <ChevronDown size={13} className="tp-combo-chevron" style={{ color: theme.inkFaint, transform: open ? 'rotate(180deg)' : undefined }} />
      </button>
      {open && (
        <div className="tp-combo-panel" style={{ background: theme.paper, border: `1px solid ${theme.border}` }}>
          <div className="tp-combo-search-wrap" style={{ borderBottom: `1px solid ${theme.border}` }}>
            <Search size={12} style={{ color: theme.inkFaint, flex: 'none' }} />
            <input
              ref={searchRef}
              className="tp-combo-search"
              placeholder="Search language…"
              value={query}
              onChange={e => { setQuery(e.target.value); setActive(0); }}
              onKeyDown={onSearchKeyDown}
              style={{ color: theme.ink }}
            />
          </div>
          <div className="tp-combo-list tp-scroll" role="listbox">
            {options.length === 0 && (
              <div className="tp-combo-empty" style={{ color: theme.inkFaint }}>No matches</div>
            )}
            {options.map((l, i) => (
              <div
                key={l.language}
                role="option"
                aria-selected={l.language === value}
                className="tp-combo-option"
                style={{ color: theme.ink, background: i === active ? theme.hoverBg : 'transparent' }}
                onMouseEnter={() => setActive(i)}
                onMouseDown={e => { e.preventDefault(); commit(l.language); }}
              >
                <span>{l.name}</span>
                {l.language === value && <Check size={12} style={{ color: theme.accent, flex: 'none' }} />}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function TranslatePage() {
  const [view, setView] = useState<'translate' | 'settings'>('translate');

  const [dark, setDark] = useState(() => localStorage.getItem('tp_dark') === '1');
  const [pinned, setPinned] = useState(() => localStorage.getItem('tp_pinned') === '1');
  const [langA, setLangA] = useState(() => localStorage.getItem('tp_lang_a') ?? 'auto');
  const [langB, setLangB] = useState(() => localStorage.getItem('tp_lang_b') ?? localStorage.getItem('tp_primary_lang') ?? '');
  const [manualMode, setManualMode] = useState(() => localStorage.getItem('tp_manual_mode') === '1');
  // the pair of languages configured once in Settings — auto mode detects
  // which one you typed and targets the other; the refresh button restores
  // the live second language back to pairSecond
  const [pairFirst, setPairFirst] = useState(() => localStorage.getItem('tp_pair_first') ?? '');
  const [pairSecond, setPairSecond] = useState(() => localStorage.getItem('tp_pair_second') ?? localStorage.getItem('tp_primary_lang') ?? '');
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('rapidapi_key') ?? '');
  const [hotkey, setHotkey] = useState(() => localStorage.getItem('tp_hotkey') ?? DEFAULT_HOTKEY);
  // source of truth is the OS registration itself, not localStorage — read
  // via isAutostartEnabled() on mount rather than assumed from a stored flag
  const [autostart, setAutostart] = useState(false);

  const [languages, setLanguages] = useState<LanguageInfo[]>(FALLBACK_LANGUAGES);

  const [inputText, setInputText] = useState('');
  const [outputText, setOutputText] = useState('');
  const [detectedCode, setDetectedCode] = useState<string | null>(null);
  const [effectiveTargetCode, setEffectiveTargetCode] = useState<string | null>(null);
  const [isTranslating, setIsTranslating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // settings-view drafts
  const [draftPairFirst, setDraftPairFirst] = useState(pairFirst);
  const [draftPairSecond, setDraftPairSecond] = useState(pairSecond);
  const [draftApiKey, setDraftApiKey] = useState(apiKey);
  const [draftHotkey, setDraftHotkey] = useState(hotkey);
  const [draftAutostart, setDraftAutostart] = useState(autostart);
  const [recordingHotkey, setRecordingHotkey] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const outerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // true while a title-bar drag (mousedown on data-tauri-drag-region) is in
  // flight — starting a native window drag causes a brief, spurious
  // window-blur that isn't an actual "click outside"
  const draggingRef = useRef(false);

  // apply the persisted (or default) hotkey once on startup
  useEffect(() => {
    invoke('set_hotkey', { accelerator: hotkey }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // read the actual OS autostart registration once on startup
  useEffect(() => {
    isAutostartEnabled().then(setAutostart).catch(() => {});
  }, []);

  // fetch full language list once a key exists
  useEffect(() => {
    if (!apiKey) return;
    invoke<LanguageInfo[]>('get_languages', { apiKey })
      .then(list => { if (list?.length) setLanguages(list); })
      .catch(() => {});
  }, [apiKey]);

  // keep the frameless window sized to the outer wrapper's full footprint
  // (offsetWidth/offsetHeight, not contentRect, so the shadow-bleed padding
  // is included and the window never clips or scrolls its own content)
  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      getCurrentWindow()
        .setSize(new LogicalSize(Math.ceil(el.offsetWidth), Math.ceil(el.offsetHeight)))
        .catch(() => {});
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [view]);

  // focus the input on first launch and every time the popup is shown again
  useEffect(() => {
    if (view !== 'translate') return;
    inputRef.current?.focus();
    const onWindowFocus = () => inputRef.current?.focus();
    window.addEventListener('focus', onWindowFocus);
    return () => window.removeEventListener('focus', onWindowFocus);
  }, [view]);

  // the backend emits this specifically when the hotkey/tray toggles the
  // window visible (not on every OS focus change), so each fresh popup
  // starts from a blank slate while the chosen languages stick around
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    try {
      getCurrentWindow()
        .listen('popup-shown', () => {
          setInputText('');
          setOutputText('');
          setDetectedCode(null);
          setEffectiveTargetCode(null);
          setError(null);
          setCopied(false);
        })
        .then(f => { unlisten = f; })
        .catch(() => {});
    } catch {
      // not running inside a Tauri webview
    }
    return () => unlisten?.();
  }, []);

  // Esc hides the popup, unless pinned
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || pinned) return;
      getCurrentWindow().hide().catch(() => {});
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [pinned]);

  // starting a title-bar drag causes a brief, spurious window-blur that
  // isn't an actual "click outside" — track it so the blur handler below
  // can ignore it
  useEffect(() => {
    let releaseTimer: ReturnType<typeof setTimeout> | null = null;
    const onMouseDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement)?.closest('[data-tauri-drag-region]')) return;
      draggingRef.current = true;
      if (releaseTimer) clearTimeout(releaseTimer);
    };
    const onMouseUp = () => {
      if (releaseTimer) clearTimeout(releaseTimer);
      releaseTimer = setTimeout(() => { draggingRef.current = false; }, 300);
    };
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('mouseup', onMouseUp, true);
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true);
      document.removeEventListener('mouseup', onMouseUp, true);
      if (releaseTimer) clearTimeout(releaseTimer);
    };
  }, []);

  // clicking outside the window hides it, unless pinned or a title-bar drag
  // is what actually triggered the blur
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    try {
      getCurrentWindow()
        .onFocusChanged(({ payload: focused }) => {
          if (!focused && !pinned && !draggingRef.current) {
            getCurrentWindow().hide().catch(() => {});
          }
        })
        .then(f => { unlisten = f; })
        .catch(() => {});
    } catch {
      // not running inside a Tauri webview
    }
    return () => unlisten?.();
  }, [pinned]);

  const langLabel = useCallback(
    (code: string | null) => languages.find(l => l.language === code)?.name ?? code ?? '',
    [languages]
  );

  const runTranslate = useCallback(async (text: string) => {
    const isAutoFirst = !langA || langA === 'auto';
    const ready = isAutoFirst ? !!(pairFirst && pairSecond) : !!langB;
    if (!text.trim() || !apiKey || !ready) {
      setOutputText('');
      setDetectedCode(null);
      setEffectiveTargetCode(null);
      setError(null);
      return;
    }

    setIsTranslating(true);
    setError(null);
    try {
      let sourceCode: string;
      let targetCode: string;

      if (isAutoFirst) {
        // the translate endpoint's inline auto-detect never actually reports
        // what it detected, so ask the dedicated detect endpoint first
        const detected = await invoke<DetectResult>('detect_language', { text, apiKey });
        sourceCode = detected.language;
        // second still at its settings default — swap between the
        // configured pair; second manually overridden — pin the target
        // regardless of what's detected
        targetCode = langB === pairSecond
          ? (detected.language === pairFirst ? pairSecond : pairFirst)
          : langB;
      } else {
        // a manually-picked first language is asserted, not detected — no
        // autodetect call, and no guessing/swapping based on content. If
        // the input isn't actually in that language, that's on the user;
        // the API translates (or fails on) exactly what was declared
        sourceCode = langA;
        targetCode = langB;
      }

      const result = await invoke<TranslateResult>('translate', {
        text, source: sourceCode, target: targetCode, apiKey,
      });

      setOutputText(result.translated_text);
      setDetectedCode(sourceCode);
      setEffectiveTargetCode(targetCode);
      setCopied(false);
    } catch (err) {
      setError(String(err));
      setOutputText('');
    } finally {
      setIsTranslating(false);
    }
  }, [apiKey, langA, langB, pairFirst, pairSecond]);

  // debounced translation
  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => runTranslate(inputText), 600);
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [inputText, runTranslate]);

  const handleCopy = useCallback(() => {
    if (outputText) writeText(outputText).catch(() => {});
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1500);
  }, [outputText]);

  // Ctrl+C copies the translation, unless the user has an actual text
  // selection they're trying to copy instead (e.g. from the input box)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.code !== 'KeyC') return;
      if (view !== 'translate' || !outputText) return;
      const hasSelection = (window.getSelection()?.toString().length ?? 0) > 0;
      if (hasSelection) return;
      e.preventDefault();
      handleCopy();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [view, outputText, handleCopy]);

  const openSettings = () => {
    setDraftPairFirst(pairFirst);
    setDraftPairSecond(pairSecond);
    setDraftApiKey(apiKey);
    setDraftHotkey(hotkey);
    setDraftAutostart(autostart);
    setSettingsError(null);
    setView('settings');
  };

  const saveSettings = async () => {
    if (draftHotkey !== hotkey) {
      try {
        await invoke('set_hotkey', { accelerator: draftHotkey });
      } catch (err) {
        setSettingsError(String(err));
        return;
      }
    }
    if (draftAutostart !== autostart) {
      try {
        await (draftAutostart ? enableAutostart() : disableAutostart());
      } catch (err) {
        setSettingsError(String(err));
        return;
      }
    }
    localStorage.setItem('rapidapi_key', draftApiKey.trim());
    localStorage.setItem('tp_hotkey', draftHotkey);
    localStorage.setItem('tp_pair_first', draftPairFirst);
    localStorage.setItem('tp_pair_second', draftPairSecond);
    // saving your language pair is how you set up (or return to) auto mode
    // — it always takes effect immediately
    localStorage.setItem('tp_lang_a', 'auto');
    localStorage.setItem('tp_lang_b', draftPairSecond);
    localStorage.setItem('tp_manual_mode', '0');
    setApiKey(draftApiKey.trim());
    setHotkey(draftHotkey);
    setPairFirst(draftPairFirst);
    setPairSecond(draftPairSecond);
    setLangA('auto');
    setLangB(draftPairSecond);
    setManualMode(false);
    setAutostart(draftAutostart);
    setView('translate');
  };

  // touching either language box by hand exits autodetect mode; the refresh
  // button is the only way back
  const handleLangAChange = (v: string) => {
    localStorage.setItem('tp_lang_a', v);
    localStorage.setItem('tp_manual_mode', '1');
    setLangA(v);
    setManualMode(true);
  };

  const handleLangBChange = (v: string) => {
    localStorage.setItem('tp_lang_b', v);
    localStorage.setItem('tp_manual_mode', '1');
    setLangB(v);
    setManualMode(true);
  };

  const handleRefresh = () => {
    localStorage.setItem('tp_lang_a', 'auto');
    localStorage.setItem('tp_lang_b', pairSecond);
    localStorage.setItem('tp_manual_mode', '0');
    setLangA('auto');
    setLangB(pairSecond);
    setManualMode(false);
  };

  // only meaningful once the first language is a concrete pick — autodetect
  // has nothing to swap into the second slot
  const handleSwapLanguages = () => {
    if (!langA || langA === 'auto') return;
    const newA = langB;
    const newB = langA;
    localStorage.setItem('tp_lang_a', newA);
    localStorage.setItem('tp_lang_b', newB);
    localStorage.setItem('tp_manual_mode', '1');
    setLangA(newA);
    setLangB(newB);
    setManualMode(true);
  };

  const toggleDark = () => {
    setDark(d => {
      localStorage.setItem('tp_dark', !d ? '1' : '0');
      return !d;
    });
  };

  const togglePinned = () => {
    setPinned(p => {
      localStorage.setItem('tp_pinned', !p ? '1' : '0');
      return !p;
    });
  };

  const handleHotkeyKeyDown = (e: React.KeyboardEvent) => {
    e.preventDefault();
    if (MODIFIER_CODES.has(e.code)) return;
    const mods: string[] = [];
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Super');
    if (mods.length === 0) return;
    setDraftHotkey([...mods, e.code].join('+'));
    setRecordingHotkey(false);
  };

  const hasOutput = !!outputText;
  const needsSetup = !apiKey || !pairFirst || !pairSecond;

  // theme tokens
  const paper     = dark ? '#2f2f2f' : '#ffffff';
  const paperSub  = dark ? '#262626' : '#fbfbfa';
  const ink       = dark ? 'rgba(255,255,255,0.9)'  : 'rgba(20,20,20,0.9)';
  const inkMuted  = dark ? 'rgba(255,255,255,0.5)'  : 'rgba(20,20,20,0.45)';
  const inkFaint  = dark ? 'rgba(255,255,255,0.35)' : 'rgba(20,20,20,0.3)';
  const border    = dark ? 'rgba(255,255,255,0.09)' : 'rgba(20,20,20,0.08)';
  const hoverBg   = dark ? 'rgba(255,255,255,0.11)' : 'rgba(20,20,20,0.07)';
  const hoverBorder = dark ? 'rgba(255,255,255,0.22)' : 'rgba(20,20,20,0.2)';
  const accent    = '#2ea0da';

  const theme: ComboTheme = { paper, paperSub, border, ink, inkFaint, hoverBg, accent };

  const cssVars = {
    '--tp-hover':            hoverBg,
    '--tp-hover-border':     hoverBorder,
    '--tp-ink':              ink,
    '--tp-close-hover':      dark ? 'rgba(255,90,90,0.22)'  : 'rgba(220,60,60,0.12)',
    '--tp-close-ink':        dark ? '#ff8080'               : '#d23c3c',
    '--tp-scroll-thumb':     dark ? 'rgba(255,255,255,0.18)': 'rgba(20,20,20,0.18)',
    '--tp-scroll-thumb-hover': dark ? 'rgba(255,255,255,0.32)': 'rgba(20,20,20,0.32)',
  } as React.CSSProperties;

  return (
    <div className="tp-outer" ref={outerRef}>
      <div
        className={`tp-card${dark ? ' tp-dark' : ''}`}
        style={{ background: paper, border: `1px solid ${border}`, ...cssVars }}
      >
        {/* Title bar — also the window drag handle */}
        <div className="tp-titlebar" data-tauri-drag-region="true">
          {view === 'settings' ? (
            <button className="tp-icon-btn" style={{ color: inkMuted }} onClick={() => setView('translate')} title="Back">
              <ArrowLeft size={14} />
            </button>
          ) : (
            <span className="tp-title" style={{ color: inkMuted }}>Translate</span>
          )}
          {view === 'settings' && <span className="tp-title" style={{ color: inkMuted }}>Settings</span>}
          <div className="tp-titlebar-actions">
            {view === 'translate' && (
              <button
                className={`tp-icon-btn${manualMode ? ' tp-icon-active' : ''}`}
                style={manualMode ? undefined : { color: inkMuted, opacity: 0.4, cursor: 'default' }}
                onClick={manualMode ? handleRefresh : undefined}
                disabled={!manualMode}
                title={manualMode ? 'Manually set — click to go back to autodetect' : 'Autodetect is active'}
              >
                <RefreshCw size={13} />
              </button>
            )}
            {view === 'translate' && (
              <button className="tp-icon-btn" style={{ color: inkMuted }} onClick={openSettings} title="Settings">
                <SettingsIcon size={13} />
              </button>
            )}
            <button className="tp-icon-btn" style={{ color: inkMuted }} onClick={toggleDark}>
              {dark ? <Sun size={13} /> : <Moon size={13} />}
            </button>
            <button
              className={`tp-icon-btn${pinned ? ' tp-icon-active' : ''}`}
              style={pinned ? undefined : { color: inkMuted }}
              onClick={togglePinned}
              title={pinned ? 'Pinned — Esc and clicking outside won\'t close it' : 'Pin (keep open when Esc or clicking outside)'}
            >
              <Pin size={13} />
            </button>
            <button className="tp-close-btn" style={{ color: inkMuted }} onClick={() => getCurrentWindow().hide()}>
              <X size={11} />
            </button>
          </div>
        </div>

        {view === 'settings' ? (
          <div className="tp-settings-body">
            <div className="tp-field">
              <label className="tp-field-label" style={{ color: inkFaint }}>First language</label>
              <LanguageCombobox value={draftPairFirst} onChange={setDraftPairFirst} placeholder="First language" languages={languages} theme={theme} />
            </div>
            <div className="tp-field">
              <label className="tp-field-label" style={{ color: inkFaint }}>Second language</label>
              <LanguageCombobox value={draftPairSecond} onChange={setDraftPairSecond} placeholder="Second language" languages={languages} theme={theme} />
            </div>
            <div className="tp-field">
              <label className="tp-field-label" style={{ color: inkFaint }}><Key size={11} /> RapidAPI key</label>
              <input
                className="tp-text-input"
                type="password"
                placeholder="Paste RapidAPI key…"
                value={draftApiKey}
                onChange={e => setDraftApiKey(e.target.value)}
                style={{ background: paperSub, border: `1px solid ${border}`, color: ink }}
              />
              <div className="tp-field-hint" style={{ color: inkFaint }}>
                Get a free key at{' '}
                <a
                  href="https://rapidapi.com/gatzuma/api/deep-translate1"
                  className="tp-hint-link"
                  style={{ color: accent }}
                  onClick={e => {
                    e.preventDefault();
                    openUrl('https://rapidapi.com/gatzuma/api/deep-translate1').catch(() => {});
                  }}
                >
                  rapidapi.com/gatzuma/api/deep-translate1
                </a>
              </div>
            </div>
            <div className="tp-field">
              <label className="tp-field-label" style={{ color: inkFaint }}><Keyboard size={11} /> Global hotkey</label>
              <button
                className="tp-hotkey-input"
                style={{ background: paperSub, border: `1px solid ${recordingHotkey ? accent : border}`, color: ink }}
                onClick={() => setRecordingHotkey(true)}
                onBlur={() => setRecordingHotkey(false)}
                onKeyDown={recordingHotkey ? handleHotkeyKeyDown : undefined}
              >
                {recordingHotkey ? 'Press a key combination…' : formatHotkey(draftHotkey)}
              </button>
            </div>
            <div className="tp-field">
              <div className="tp-toggle-row">
                <label className="tp-field-label" style={{ color: inkFaint }}><Power size={11} /> Start with Windows</label>
                <button
                  type="button"
                  role="switch"
                  aria-checked={draftAutostart}
                  className="tp-switch"
                  onClick={() => setDraftAutostart(v => !v)}
                  style={{ background: draftAutostart ? accent : hoverBg }}
                >
                  <span className="tp-switch-thumb" style={{ transform: draftAutostart ? 'translateX(15px)' : undefined }} />
                </button>
              </div>
              <div className="tp-field-hint" style={{ color: inkFaint }}>
                Launches quietly in the tray — press the hotkey to open.
              </div>
            </div>
            {settingsError && (
              <div className="tp-error" style={{ color: dark ? '#ff8080' : '#d23c3c' }}>{settingsError}</div>
            )}
            <button className="tp-save-btn" style={{ background: accent }} onClick={saveSettings}>
              Save
            </button>
          </div>
        ) : (
          <>
            <div className="tp-lang-bar">
              <LanguageCombobox value={langA} onChange={handleLangAChange} placeholder="First language" languages={languages} includeAutoDetect theme={theme} />
              <button
                className={`tp-lang-refresh${(langA && langA !== 'auto') ? ' tp-lang-refresh-active' : ''}`}
                onClick={(langA && langA !== 'auto') ? handleSwapLanguages : undefined}
                disabled={!langA || langA === 'auto'}
                title={(langA && langA !== 'auto') ? 'Swap languages' : 'Pick a first language to swap'}
              >
                <ArrowRightLeft size={13} />
              </button>
              <LanguageCombobox value={langB} onChange={handleLangBChange} placeholder="Second language" languages={languages} showAsAuto={!manualMode} theme={theme} />
            </div>

            {needsSetup && (
              <div className="tp-banner" style={{ background: dark ? 'rgba(255,160,0,0.12)' : 'rgba(255,160,0,0.1)', color: inkMuted }}>
                <SettingsIcon size={12} /> Configure your languages and API key in Settings
              </div>
            )}

            <div className="tp-divider" style={{ background: border }} />

            {/* Input */}
            <div className="tp-block">
              <textarea
                ref={inputRef}
                className="tp-textarea tp-scroll"
                placeholder="Type to translate…"
                value={inputText}
                onChange={e => setInputText(e.target.value)}
                style={{ color: ink }}
              />
              <div className="tp-char-count" style={{ color: inkFaint }}>{inputText.length} / 2000</div>
            </div>

            <div className="tp-divider" style={{ background: border }} />

            {/* Output */}
            <div className="tp-block">
              <div className="tp-output-wrap">
                {isTranslating && (
                  <div className="tp-loader" style={{ color: inkMuted }}>
                    <Loader2 size={14} className="tp-spin" />
                  </div>
                )}
                {error && !isTranslating && (
                  <div className="tp-error" style={{ color: dark ? '#ff8080' : '#d23c3c' }}>{error}</div>
                )}
                {!isTranslating && !error && (
                  <div
                    className="tp-output"
                    style={{ color: hasOutput ? ink : inkFaint, fontStyle: hasOutput ? 'normal' : 'italic' }}
                  >
                    {hasOutput ? outputText : 'Translation will appear here'}
                  </div>
                )}
              </div>
              <div className="tp-output-footer">
                {hasOutput && detectedCode && effectiveTargetCode && (
                  <span className="tp-detected" style={{ color: inkFaint }}>
                    Detected: {langLabel(detectedCode)} → {langLabel(effectiveTargetCode)}
                  </span>
                )}
                <button
                  className="tp-copy"
                  style={{ background: copied ? '#1f9d55' : accent, opacity: hasOutput ? 1 : 0.35, pointerEvents: hasOutput ? 'auto' : 'none' }}
                  onClick={handleCopy}
                  disabled={!hasOutput}
                >
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
