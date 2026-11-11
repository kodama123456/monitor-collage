/**
 * 写真の解析（すべて端末内で実行）。
 * 技術検証 tools/validation/detect.py と同じ考え方:
 *  - 顔検出: 顔の位置（全角度で安定）
 *  - 顔ランドマーク: 目の輪郭・顎先（横顔は取れないことがある）
 *  - 姿勢推定: 目のおおよその位置（横顔の予備）
 *  - 人物領域: 頭頂部の推定と、背景を真っ黒にするためのマスク
 */
import {
  FaceDetector,
  FaceLandmarker,
  FilesetResolver,
  ImageSegmenter,
  PoseLandmarker,
} from '@mediapipe/tasks-vision';

export interface Ellipse {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

export interface Analysis {
  /** 元写真（縮小済み）のサイズ */
  w: number;
  h: number;
  faceFound: boolean;
  /** 頭頂部・顎先の y、頭の横中心 x（元写真の座標） */
  top: number;
  chin: number;
  cx: number;
  /** 顔の枠の幅（ぼかし追加時の大きさの目安） */
  faceW: number;
  /** 自動で求めた目元ぼかし（元写真の座標） */
  eyes: Ellipse[];
  /** 目の位置を予備手段で推定した／顔が見つからない → 「要確認」 */
  needsCheck: boolean;
  /** 人物領域マスク（解析解像度）。広げてぼかし済み 0〜255 */
  mask: Uint8ClampedArray;
  maskW: number;
  maskH: number;
  /** 黒幕の明るさ（これ以下を真っ黒にする） */
  blackPoint: number;
}

let tasks: {
  face: FaceDetector;
  lm: FaceLandmarker;
  pose: PoseLandmarker;
  seg: ImageSegmenter;
} | null = null;

export async function loadModels(base: string) {
  if (tasks) return;
  const fileset = await FilesetResolver.forVisionTasks(base + 'wasm');
  const opt = (file: string) => ({ modelAssetPath: base + 'models/' + file, delegate: 'CPU' as const });
  const [face, lm, pose, seg] = await Promise.all([
    FaceDetector.createFromOptions(fileset, {
      baseOptions: opt('blaze_face_short_range.tflite'),
      minDetectionConfidence: 0.3,
    }),
    FaceLandmarker.createFromOptions(fileset, {
      baseOptions: opt('face_landmarker.task'),
      numFaces: 1,
      minFaceDetectionConfidence: 0.3,
      minFacePresenceConfidence: 0.3,
    }),
    PoseLandmarker.createFromOptions(fileset, {
      baseOptions: opt('pose_landmarker_lite.task'),
      minPoseDetectionConfidence: 0.3,
      minPosePresenceConfidence: 0.3,
    }),
    ImageSegmenter.createFromOptions(fileset, {
      baseOptions: opt('selfie_segmenter.tflite'),
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    }),
  ]);
  tasks = { face, lm, pose, seg };
}

const EYE_A = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
const EYE_B = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398];
const CHIN = 152;
const ANALYSIS_MAX = 1024;

/** src: 縮小済みの元写真（キャンバス） */
export function analyze(src: HTMLCanvasElement): Analysis {
  if (!tasks) throw new Error('models not loaded');
  const W = src.width;
  const H = src.height;
  const k = Math.min(1, ANALYSIS_MAX / Math.max(W, H));
  const aw = Math.round(W * k);
  const ah = Math.round(H * k);
  const small = document.createElement('canvas');
  small.width = aw;
  small.height = ah;
  small.getContext('2d')!.drawImage(src, 0, 0, aw, ah);
  const up = 1 / k; // 解析座標 → 元写真座標

  // 人物領域
  const segRes = tasks.seg.segment(small);
  const conf = segRes.confidenceMasks![0].getAsFloat32Array();
  const raw = new Uint8Array(aw * ah);
  for (let i = 0; i < raw.length; i++) raw[i] = conf[i] > 0.5 ? 1 : 0;
  segRes.close();

  // 黒幕の明るさ（背景の 99 パーセンタイル + 4）
  const px = small.getContext('2d')!.getImageData(0, 0, aw, ah).data;
  const hist = new Uint32Array(256);
  let nbg = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i]) continue;
    const l = Math.round(0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]);
    hist[l]++;
    nbg++;
  }
  let acc = 0;
  let p99 = 20;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= nbg * 0.99) {
      p99 = v;
      break;
    }
  }
  const blackPoint = Math.min(45, Math.max(8, p99 + 4));

  // 顔
  const fd = tasks.face.detect(small).detections[0];
  const fl = tasks.lm.detect(small).faceLandmarks[0];
  const po = tasks.pose.detect(small).landmarks[0];

  let fx: number, fy: number, fw: number, fh: number;
  const faceFound = !!fd?.boundingBox;
  if (fd?.boundingBox) {
    ({ originX: fx, originY: fy, width: fw, height: fh } = fd.boundingBox);
  } else {
    // 顔が見つからない: 中央に仮の枠（「要確認」）
    fw = aw * 0.25;
    fh = ah * 0.35;
    fx = (aw - fw) / 2;
    fy = ah * 0.25;
  }

  // 顎先: ランドマーク → 無ければ顔枠の下端
  const chin = fl ? fl[CHIN].y * ah : fy + fh;

  // 頭頂部: 顔の横幅付近で人物領域が始まる高さ
  const x0 = Math.max(0, Math.floor(fx - fw * 0.3));
  const x1 = Math.min(aw, Math.ceil(fx + fw * 1.3));
  let top = fy - fh * 0.5;
  outer: for (let y = 0; y < ah; y++) {
    for (let x = x0; x < x1; x++) {
      if (raw[y * aw + x]) {
        top = y;
        break outer;
      }
    }
  }
  // 頭の横中心: 頭頂〜目の高さの人物領域の左右の中央
  const eyeY = Math.floor(fy + fh * 0.35);
  let minX = aw;
  let maxX = -1;
  for (let y = Math.max(0, Math.floor(top)); y < Math.min(ah, eyeY); y++) {
    for (let x = 0; x < aw; x++) {
      if (raw[y * aw + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  }
  const cx = maxX >= 0 ? (minX + maxX) / 2 : fx + fw / 2;

  // 目元ぼかし
  const eyes: Ellipse[] = [];
  let needsCheck = !faceFound;
  if (fl) {
    for (const idx of [EYE_A, EYE_B]) {
      let ex0 = Infinity, ey0 = Infinity, ex1 = -Infinity, ey1 = -Infinity;
      for (const i of idx) {
        const x = fl[i].x * aw;
        const y = fl[i].y * ah;
        ex0 = Math.min(ex0, x); ex1 = Math.max(ex1, x);
        ey0 = Math.min(ey0, y); ey1 = Math.max(ey1, y);
      }
      const w = ex1 - ex0;
      if (w < 2) continue;
      eyes.push({
        cx: ((ex0 + ex1) / 2) * up,
        cy: ((ey0 + ey1) / 2) * up,
        rx: w * 0.85 * up,
        ry: Math.max(ey1 - ey0, w * 0.45) * 1.3 * up,
      });
    }
  } else if (po && faceFound) {
    // 横顔などで目の輪郭が取れない → 姿勢推定のおおよその位置（要確認）
    const ex = ((po[2].x + po[5].x) / 2) * aw;
    const ey = ((po[2].y + po[5].y) / 2) * ah;
    eyes.push({ cx: ex * up, cy: ey * up, rx: fw * 0.17 * up, ry: fw * 0.1 * up });
    needsCheck = true;
  } else {
    needsCheck = true;
  }

  return {
    w: W,
    h: H,
    faceFound,
    top: top * up,
    chin: chin * up,
    cx: cx * up,
    faceW: fw * up,
    eyes,
    needsCheck,
    mask: softenMask(raw, aw, ah),
    maskW: aw,
    maskH: ah,
    blackPoint,
  };
}

/** 人物領域を少し広げてから、境目をなめらかにする（背景だけを確実に黒くするため） */
function softenMask(m: Uint8Array, w: number, h: number): Uint8ClampedArray {
  const r = Math.max(2, Math.round(Math.max(w, h) * 0.006)); // 広げる量
  const tmp = new Uint8Array(w * h);
  const dil = new Uint8Array(w * h);
  // 横方向の最大値
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let d = -r; d <= r && !v; d++) {
        const xx = x + d;
        if (xx >= 0 && xx < w && m[y * w + xx]) v = 1;
      }
      tmp[y * w + x] = v;
    }
  }
  // 縦方向の最大値
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let d = -r; d <= r && !v; d++) {
        const yy = y + d;
        if (yy >= 0 && yy < h && tmp[yy * w + x]) v = 1;
      }
      dil[y * w + x] = v;
    }
  }
  // ぼかし（箱型フィルタ×2）
  let a: Float32Array = Float32Array.from(dil, (v) => v * 255);
  const br = Math.max(2, Math.round(r * 1.5));
  for (let pass = 0; pass < 2; pass++) a = boxBlur(a, w, h, br);
  return Uint8ClampedArray.from(a);
}

function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const n = r * 2 + 1;
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = -r; x <= r; x++) s += src[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = s / n;
      s += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / n;
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}
