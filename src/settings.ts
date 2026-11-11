export type Ratio = '16:9' | '3:2';

export interface Settings {
  ratio: Ratio;
  /** 頭頂部〜顎先の高さ（枠の高さ比）。正面・斜め・横顔に適用。あおりはこの値から自動で決める */
  faceSize: number;
  /** ぼかしの強さ 1〜10 */
  blurStrength: number;
  /** ぼかしの範囲（倍率） */
  blurSize: number;
  /** 目元ぼかしの初期値 */
  blurDefault: boolean;
}

export const DEFAULTS: Settings = {
  ratio: '16:9',
  faceSize: 0.76,
  blurStrength: 6,
  blurSize: 1,
  blurDefault: true,
};

const KEY = 'monitor-collage-settings-v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* 保存できない環境では初期値 */
  }
  return { ...DEFAULTS };
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* noop */
  }
}

/** 出力全体のサイズ（2×2 の合計） */
export function outputSize(r: Ratio) {
  return r === '16:9' ? { w: 3840, h: 2160 } : { w: 4800, h: 3200 };
}
