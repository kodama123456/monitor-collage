/**
 * 1枠の描画: 自動配置（＋手動調整）→ 背景を真っ黒に → 目元ぼかし
 * 技術検証 tools/validation/compose.py と同じルール。
 */
import type { Analysis, Ellipse } from './detect';
import type { Settings } from './settings';

export type Kind = 'front' | 'oblique' | 'aori' | 'profile';

export const KINDS: Kind[] = ['front', 'oblique', 'aori', 'profile'];
export const LABEL: Record<Kind, string> = { front: '正面', oblique: '斜め', aori: 'あおり', profile: '横顔' };

/** 頭頂部の位置（枠の上端からの比）と、あおりの大きさ係数 */
const TOP: Record<Kind, number> = { front: 0.07, oblique: 0.07, profile: 0.07, aori: 0.16 };
const AORI_FACTOR = 0.52 / 0.76;

/** 調整画面の目安線（枠の高さ比）: 頭頂部・顎先 */
export function guides(kind: Kind, set: Settings) {
  const head = kind === 'aori' ? set.faceSize * AORI_FACTOR : set.faceSize;
  return { top: TOP[kind], chin: TOP[kind] + head };
}

/** 色やトーンを変えない明るさ（これ以上は一切触らない） */
const KNEE = 64;

export interface Adjust {
  /** 自動配置に対する拡大率 */
  zoom: number;
  /** 枠サイズに対する移動量（比率） */
  dx: number;
  dy: number;
}

export interface SlotState {
  kind: Kind;
  photo: HTMLCanvasElement;
  a: Analysis;
  adj: Adjust;
  blurs: Ellipse[];
  blurOn: boolean;
}

export const NO_ADJUST: Adjust = { zoom: 1, dx: 0, dy: 0 };

/** 元写真座標 → 枠座標 の変換（x' = s*x + tx） */
export function transformOf(st: SlotState, CW: number, CH: number, set: Settings) {
  const a = st.a;
  const headRatio = st.kind === 'aori' ? set.faceSize * AORI_FACTOR : set.faceSize;
  let s: number, tx: number, ty: number;
  if (a.faceFound && a.chin - a.top > 10) {
    s = (headRatio * CH) / (a.chin - a.top);
    tx = CW / 2 - a.cx * s;
    ty = TOP[st.kind] * CH - a.top * s;
  } else {
    s = CH / a.h;
    tx = (CW - a.w * s) / 2;
    ty = 0;
  }
  // 手動調整: 枠の中央を基準に拡大し、移動
  const z = st.adj.zoom;
  s *= z;
  tx = (tx - CW / 2) * z + CW / 2 + st.adj.dx * CW;
  ty = (ty - CH / 2) * z + CH / 2 + st.adj.dy * CH;
  return { s, tx, ty };
}

const curveCache = new Map<number, Float32Array>();
/** 明るさ L → 倍率。黒幕の明るさ以下は 0、KNEE 以上は 1（そのまま） */
function gainLut(black: number): Float32Array {
  let lut = curveCache.get(black);
  if (lut) return lut;
  lut = new Float32Array(256);
  for (let v = 0; v < 256; v++) {
    if (v >= KNEE) lut[v] = 1;
    else {
      const t = Math.min(1, Math.max(0, (v - black) / (KNEE - black)));
      const out = KNEE * Math.pow(t, 1.6);
      lut[v] = v > 0 ? out / v : 0;
    }
  }
  curveCache.set(black, lut);
  return lut;
}

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

let maskCanvasCache: WeakMap<Analysis, HTMLCanvasElement> = new WeakMap();
function maskCanvas(a: Analysis) {
  let c = maskCanvasCache.get(a);
  if (c) return c;
  c = canvas(a.maskW, a.maskH);
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(a.maskW, a.maskH);
  for (let i = 0; i < a.mask.length; i++) {
    img.data[i * 4 + 3] = a.mask[i];
  }
  ctx.putImageData(img, 0, 0);
  maskCanvasCache.set(a, c);
  return c;
}

/**
 * 1枠を描く。ctx の (ox, oy) から CW×CH の範囲に描画する。
 */
export function renderCell(
  out: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  CW: number,
  CH: number,
  st: SlotState,
  set: Settings,
) {
  const { s, tx, ty } = transformOf(st, CW, CH, set);
  const cell = canvas(CW, CH);
  const c = cell.getContext('2d', { willReadFrequently: true })!;
  c.fillStyle = '#000';
  c.fillRect(0, 0, CW, CH);
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';
  c.setTransform(s, 0, 0, s, tx, ty);
  c.drawImage(st.photo, 0, 0);

  // 人物領域マスクを同じ位置に重ねる
  const mk = canvas(CW, CH);
  const m = mk.getContext('2d', { willReadFrequently: true })!;
  const ms = st.a.w / st.a.maskW;
  m.imageSmoothingEnabled = true;
  m.setTransform(s * ms, 0, 0, s * ms, tx, ty);
  m.drawImage(maskCanvas(st.a), 0, 0);
  c.setTransform(1, 0, 0, 1, 0, 0);

  // 背景を真っ黒に（シャドウだけを締め、明るい部分は変えない）
  const img = c.getImageData(0, 0, CW, CH);
  const d = img.data;
  const md = m.getImageData(0, 0, CW, CH).data;
  const lut = gainLut(st.a.blackPoint);
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const l = (0.299 * r + 0.587 * g + 0.114 * b + 0.5) | 0;
    const k = lut[l] * (md[i + 3] / 255);
    if (k === 1) continue;
    d[i] = r * k;
    d[i + 1] = g * k;
    d[i + 2] = b * k;
  }
  c.putImageData(img, 0, 0);

  // 目元ぼかし
  if (st.blurOn && st.blurs.length) {
    applyBlur(cell, st.blurs.map((e) => toCell(e, s, tx, ty, set.blurSize)), set.blurStrength);
  }

  out.drawImage(cell, ox, oy);
}

function toCell(e: Ellipse, s: number, tx: number, ty: number, size: number): Ellipse {
  return { cx: e.cx * s + tx, cy: e.cy * s + ty, rx: e.rx * s * size, ry: e.ry * s * size };
}

function applyBlur(cell: HTMLCanvasElement, ells: Ellipse[], strength: number) {
  const W = cell.width;
  const H = cell.height;
  // ぼかし画像: 縮小 → 拡大を繰り返す（端末差のない、軽いぼかし）
  const f = Math.max(4, Math.round(4 + strength * 3)); // 縮小率
  const sw = Math.max(1, Math.round(W / f));
  const sh = Math.max(1, Math.round(H / f));
  const small = canvas(sw, sh);
  const sc = small.getContext('2d')!;
  sc.imageSmoothingQuality = 'high';
  sc.drawImage(cell, 0, 0, sw, sh);
  const tiny = canvas(Math.max(1, sw >> 1), Math.max(1, sh >> 1));
  tiny.getContext('2d')!.drawImage(small, 0, 0, tiny.width, tiny.height);
  sc.clearRect(0, 0, sw, sh);
  sc.drawImage(tiny, 0, 0, sw, sh);
  const blurred = canvas(W, H);
  const bc = blurred.getContext('2d')!;
  bc.imageSmoothingQuality = 'high';
  bc.drawImage(small, 0, 0, W, H);

  // 楕円のマスク（ふちをなめらかに）
  const mask = canvas(W, H);
  const mc = mask.getContext('2d')!;
  for (const e of ells) {
    mc.save();
    mc.translate(e.cx, e.cy);
    mc.scale(1, e.ry / Math.max(1, e.rx));
    const g = mc.createRadialGradient(0, 0, 0, 0, 0, e.rx);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(0.7, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    mc.fillStyle = g;
    mc.beginPath();
    mc.arc(0, 0, e.rx, 0, Math.PI * 2);
    mc.fill();
    mc.restore();
  }
  mc.globalCompositeOperation = 'source-in';
  mc.drawImage(blurred, 0, 0);
  cell.getContext('2d')!.drawImage(mask, 0, 0);
}

/** 2×2 にまとめる */
export function renderCollage(
  out: HTMLCanvasElement,
  slots: Partial<Record<Kind, SlotState>>,
  set: Settings,
) {
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, out.width, out.height);
  const CW = out.width / 2;
  const CH = out.height / 2;
  KINDS.forEach((k, i) => {
    const st = slots[k];
    if (st) renderCell(ctx, (i % 2) * CW, Math.floor(i / 2) * CH, CW, CH, st, set);
  });
}
