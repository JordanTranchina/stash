/**
 * Unit tests for Reading Mode & In-Article Customization (Product Spec)
 */

'use strict';

describe('Reader Settings & In-Article Customization', () => {
  const READER_FONT_STACKS = {
    sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    serif: '"Merriweather", Georgia, Cambria, "Times New Roman", Times, serif',
    mono: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    lexend: '"Lexend", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  };

  const READER_THEME_COLORS = {
    white: {
      bg: '#ffffff',
      text: '#111827',
      border: '#e5e7eb',
      meta: '#6b7280',
    },
    sepia: {
      bg: '#F5EADB',
      text: '#2D241E',
      border: '#dfd2be',
      meta: '#7a6b58',
    },
    dark: {
      bg: '#121212',
      text: '#E4E4E7',
      border: '#27272a',
      meta: '#9ca3af',
    },
  };

  const READER_DEFAULTS = {
    font: 'sans',
    scale: 100,
    theme: 'white',
    syncAcrossArticles: true,
  };

  let mockStore = {};
  const mockLocalStorage = {
    getItem: (k) => mockStore[k] ?? null,
    setItem: (k, v) => { mockStore[k] = String(v); },
    removeItem: (k) => { delete mockStore[k]; },
  };

  beforeEach(() => {
    mockStore = {};
  });

  describe('Defaults and Font/Theme Maps', () => {
    test('has expected default values', () => {
      expect(READER_DEFAULTS.font).toBe('sans');
      expect(READER_DEFAULTS.scale).toBe(100);
      expect(READER_DEFAULTS.theme).toBe('white');
      expect(READER_DEFAULTS.syncAcrossArticles).toBe(true);
    });

    test('supports all 4 font families with appropriate fallbacks', () => {
      expect(READER_FONT_STACKS.sans).toContain('sans-serif');
      expect(READER_FONT_STACKS.serif).toContain('Merriweather');
      expect(READER_FONT_STACKS.mono).toContain('monospace');
      expect(READER_FONT_STACKS.lexend).toContain('Lexend');
    });

    test('supports all 3 theme color schemes with exact spec hex codes', () => {
      expect(READER_THEME_COLORS.white.bg.toLowerCase()).toBe('#ffffff');
      expect(READER_THEME_COLORS.sepia.bg.toLowerCase()).toBe('#f5eadb');
      expect(READER_THEME_COLORS.dark.bg.toLowerCase()).toBe('#121212');
    });
  });

  describe('Scale Clamping (100% to 175%)', () => {
    function clampScale(scale) {
      return Math.min(175, Math.max(100, Math.round(Number(scale) || 100)));
    }

    test('clamps values below 100 to 100', () => {
      expect(clampScale(50)).toBe(100);
      expect(clampScale(0)).toBe(100);
      expect(clampScale(-20)).toBe(100);
    });

    test('clamps values above 175 to 175', () => {
      expect(clampScale(180)).toBe(175);
      expect(clampScale(250)).toBe(175);
    });

    test('preserves valid in-range values', () => {
      expect(clampScale(100)).toBe(100);
      expect(clampScale(125)).toBe(125);
      expect(clampScale(150)).toBe(150);
      expect(clampScale(175)).toBe(175);
    });
  });

  describe('Storage Persistence (stash_reader_settings)', () => {
    function loadSettings(storage) {
      let settings = { ...READER_DEFAULTS };
      const stored = storage.getItem('stash_reader_settings');
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          if (parsed && typeof parsed === 'object') {
            if (READER_FONT_STACKS[parsed.font]) settings.font = parsed.font;
            if (Number.isFinite(parsed.scale)) {
              settings.scale = Math.min(175, Math.max(100, Math.round(parsed.scale)));
            }
            if (READER_THEME_COLORS[parsed.theme]) settings.theme = parsed.theme;
            if (typeof parsed.syncAcrossArticles === 'boolean') {
              settings.syncAcrossArticles = parsed.syncAcrossArticles;
            }
          }
        } catch (_) {}
      }
      return settings;
    }

    test('loads defaults when localStorage is empty', () => {
      const settings = loadSettings(mockLocalStorage);
      expect(settings).toEqual(READER_DEFAULTS);
    });

    test('loads saved preferences from localStorage', () => {
      mockLocalStorage.setItem('stash_reader_settings', JSON.stringify({
        font: 'serif',
        scale: 150,
        theme: 'sepia',
        syncAcrossArticles: true,
      }));
      const settings = loadSettings(mockLocalStorage);
      expect(settings.font).toBe('serif');
      expect(settings.scale).toBe(150);
      expect(settings.theme).toBe('sepia');
      expect(settings.syncAcrossArticles).toBe(true);
    });

    test('sanitizes out-of-range scale and invalid font/theme', () => {
      mockLocalStorage.setItem('stash_reader_settings', JSON.stringify({
        font: 'comic-sans',
        scale: 999,
        theme: 'neon-pink',
      }));
      const settings = loadSettings(mockLocalStorage);
      expect(settings.font).toBe('sans');
      expect(settings.scale).toBe(175);
      expect(settings.theme).toBe('white');
    });

    test('handles malformed JSON gracefully', () => {
      mockLocalStorage.setItem('stash_reader_settings', '{malformed json');
      const settings = loadSettings(mockLocalStorage);
      expect(settings).toEqual(READER_DEFAULTS);
    });
  });

  describe('Reactive CSS Custom Properties', () => {
    function computeReaderStyles(settings) {
      const fontStack = READER_FONT_STACKS[settings.font] || READER_FONT_STACKS.sans;
      const themeColors = READER_THEME_COLORS[settings.theme] || READER_THEME_COLORS.white;
      const scale = Math.min(175, Math.max(100, settings.scale || 100));

      return {
        '--reader-font': fontStack,
        '--reader-scale': `${scale}%`,
        '--reader-scale-num': String(scale / 100),
        '--reader-bg': themeColors.bg,
        '--reader-text': themeColors.text,
        '--reader-border': themeColors.border,
        '--reader-meta': themeColors.meta,
      };
    }

    test('computes correct CSS variables for sepia theme at 150%', () => {
      const styles = computeReaderStyles({
        font: 'serif',
        scale: 150,
        theme: 'sepia',
      });

      expect(styles['--reader-font']).toBe(READER_FONT_STACKS.serif);
      expect(styles['--reader-scale']).toBe('150%');
      expect(styles['--reader-scale-num']).toBe('1.5');
      expect(styles['--reader-bg']).toBe('#F5EADB');
      expect(styles['--reader-text']).toBe('#2D241E');
    });

    test('computes correct CSS variables for dark theme with Lexend font at 125%', () => {
      const styles = computeReaderStyles({
        font: 'lexend',
        scale: 125,
        theme: 'dark',
      });

      expect(styles['--reader-font']).toBe(READER_FONT_STACKS.lexend);
      expect(styles['--reader-scale']).toBe('125%');
      expect(styles['--reader-scale-num']).toBe('1.25');
      expect(styles['--reader-bg']).toBe('#121212');
      expect(styles['--reader-text']).toBe('#E4E4E7');
    });
  });
});
