import './style.css';
import { analyze, loadModels, type Ellipse } from './detect';
import {
  guides,
  KINDS,
  LABEL,
  NO_ADJUST,
  renderCell,
  renderCollage,
  transformOf,
  type Kind,
  type SlotState,
} from './render';
import { loadSettings, outputSize, saveSettings, type Ratio } from './settings';

const BASE = import.meta.env.BASE_URL;
const app = document.getElementById('app')!;

const settings = loadSettings();
const slots: Partial<Record<Kind, SlotState>> = {};
const reviewed = new Set<Kind>();
const busy = new Set<Kind>();
let blurAll = settings.blurDefault;
let modelsState: 'loading' | 'ready' | 'error' = 'loading';

const modelsReady = loadModels(BASE)
  .then(() => {
    modelsState = 'ready';
    if (currentScreen === 'home') showHome();
  })
  .catch((e) => {
    console.error(e);
    modelsState = 'error';
    if (currentScreen === 'home') showHome();
  });

let currentScreen: 'home' | 'edit' | 'settings' = 'home';

// ---------- 共通 ----------
const h = (html: string) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
};
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = app) => root.querySelector(sel) as T;

function cellSize(scale: number) {
  const o = outputSize(settings.ratio);
  return { CW: Math.round((o.w / 2) * scale), CH: Math.round((o.h / 2) * scale) };
}

/** 写真を読み込み、長辺 3200px までに縮小（メモリ節約。出力に十分な解像度） */
async function loadPhoto(file: File): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    // decode() は画面が非表示のとき待たされることがあるため、load イベントで待つ
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('画像を読み込めません'));
      img.src = url;
    });
    const k = Math.min(1, 3200 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function pickFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

async function setPhoto(kind: Kind, file: File) {
  busy.add(kind);
  if (currentScreen === 'home') showHome();
  try {
    const photo = await loadPhoto(file);
    await modelsReady;
    if (modelsState !== 'ready') throw new Error('解析の準備ができていません');
    await new Promise((r) => setTimeout(r, 0));
    const a = analyze(photo);
    slots[kind] = { kind, photo, a, adj: { ...NO_ADJUST }, blurs: a.eyes.map((e) => ({ ...e })), blurOn: blurAll };
    reviewed.delete(kind);
  } catch (e) {
    console.error(e);
    alert('写真を読み込めませんでした。別の写真を選んでください。');
  } finally {
    busy.delete(kind);
  }
  if (currentScreen === 'home') showHome();
}

async function choose(kind: Kind) {
  const f = await pickFile();
  if (f) await setPhoto(kind, f);
}

// ---------- 画面1・2: ホーム ----------
function showHome() {
  currentScreen = 'home';
  const filled = KINDS.filter((k) => slots[k]).length;
  const anyPhoto = filled > 0;
  const { CW, CH } = cellSize(1 / 3);
  app.replaceChildren(
    h(`<div class="bar"><div class="side"><button class="link" id="toSettings">設定</button></div>
      <div class="title">モニター写真作成</div>
      <div class="side r"><button class="link ${anyPhoto ? '' : 'hidden'}" id="reset">やり直す</button></div></div>`),
  );
  const grid = h(`<div class="grid"></div>`);
  KINDS.forEach((k, i) => {
    const st = slots[k];
    const b = h(`<button class="cell" aria-label="${LABEL[k]}"></button>`);
    const cv = document.createElement('canvas');
    cv.width = CW;
    cv.height = CH;
    const ctx = cv.getContext('2d')!;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, CW, CH);
    b.append(cv);
    if (st) {
      renderCell(ctx, 0, 0, CW, CH, st, settings);
      if (st.a.needsCheck && !reviewed.has(k)) b.append(h(`<span class="badge">要確認</span>`));
    } else if (!busy.has(k)) {
      b.append(h(`<div class="empty"><b>＋</b>${'①②③④'[i]} ${LABEL[k]}</div>`));
    }
    if (busy.has(k)) b.append(h(`<div class="busy">解析中…</div>`));
    b.onclick = () => {
      if (busy.has(k)) return;
      if (slots[k]) showEditor(k);
      else choose(k);
    };
    grid.append(b);
  });
  app.append(grid);

  const status =
    modelsState === 'loading'
      ? '準備中…（初回のみ少し時間がかかります）'
      : modelsState === 'error'
        ? '⚠️ 解析の準備に失敗しました。ネットにつないで再読み込みしてください。'
        : filled < 4
          ? '枠をタップして、写真を1枚ずつ選んでください。'
          : '枠をタップすると、その写真を調整できます。';
  app.append(h(`<p class="note">${status}</p>`));

  const list = h(`<div class="list">
    <div class="row">目元ぼかし<label class="switch"><input type="checkbox" id="blurAll" ${blurAll ? 'checked' : ''}><span></span></label></div>
    <div class="row">出力サイズ<div class="seg" id="ratio">
      <button data-r="16:9" class="${settings.ratio === '16:9' ? 'on' : ''}">16:9</button>
      <button data-r="3:2" class="${settings.ratio === '3:2' ? 'on' : ''}">3:2</button></div></div>
  </div>`);
  app.append(list, h(`<div class="spacer"></div>`));
  const save = h(`<button class="btn" id="save" ${filled === 4 && !busy.size ? '' : 'disabled'}>保存する</button>`);
  app.append(save, h(`<p class="note">写真はこの iPhone の中だけで処理し、外部には送信しません。</p>`));

  $('#toSettings').onclick = showSettings;
  $('#reset').onclick = () => {
    if (!confirm('選んだ写真をすべて外して、最初からやり直しますか？')) return;
    for (const k of KINDS) delete slots[k];
    reviewed.clear();
    showHome();
  };
  $<HTMLInputElement>('#blurAll').onchange = (e) => {
    blurAll = (e.target as HTMLInputElement).checked;
    for (const k of KINDS) if (slots[k]) slots[k]!.blurOn = blurAll;
    showHome();
  };
  $('#ratio').querySelectorAll('button').forEach((btn) => {
    btn.onclick = () => {
      settings.ratio = btn.dataset.r as Ratio;
      saveSettings(settings);
      showHome();
    };
  });
  save.onclick = exportImage;
}

// ---------- 画面3: 枠の調整 ----------
function showEditor(kind: Kind) {
  currentScreen = 'edit';
  const orig = slots[kind]!;
  // 編集用のコピー（キャンセルで元に戻す）
  const st: SlotState = { ...orig, adj: { ...orig.adj }, blurs: orig.blurs.map((e) => ({ ...e })) };
  let selected = -1;
  const { CW, CH } = cellSize(0.5);
  const g = guides(kind, settings);

  app.replaceChildren(
    h(`<div class="bar"><div class="side"><button class="link" id="cancel">キャンセル</button></div>
      <div class="title">${'①②③④'[KINDS.indexOf(kind)]} ${LABEL[kind]}</div>
      <div class="side r"><button class="link" id="done"><b>完了</b></button></div></div>`),
  );
  const stage = h(`<div class="stage"></div>`);
  const cv = document.createElement('canvas');
  cv.width = CW;
  cv.height = CH;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${CW} ${CH}`);
  stage.append(cv, svg);
  app.append(stage);
  app.append(
    h(`<p class="note">1本指でドラッグ → 写真を移動、2本指でピンチ → 拡大・縮小。<br>
      ぼかし（点線の楕円）をタップすると選択でき、ドラッグで移動、ピンチで大きさを変えられます。</p>`),
  );
  app.append(
    h(`<div class="list"><div class="row">この枠の目元ぼかし<label class="switch"><input type="checkbox" id="blurOn" ${st.blurOn ? 'checked' : ''}><span></span></label></div></div>`),
  );
  app.append(
    h(`<div class="btns">
      <button class="btn ghost" id="add">＋ ぼかしを追加</button>
      <button class="btn ghost" id="del" disabled>選んだぼかしを削除</button>
      <button class="btn ghost" id="auto">自動配置に戻す</button>
      <button class="btn ghost" id="repick">写真を選び直す</button></div>`),
  );

  const ctx = cv.getContext('2d')!;
  let raf = 0;
  const draw = () => {
    raf = 0;
    renderCell(ctx, 0, 0, CW, CH, st, settings);
    const { s, tx, ty } = transformOf(st, CW, CH, settings);
    const lines = [
      [g.top, '頭頂部の目安'],
      [g.chin, '顎先の目安'],
    ]
      .map(
        ([r, t]) =>
          `<line x1="0" x2="${CW}" y1="${(r as number) * CH}" y2="${(r as number) * CH}" stroke="#5ac8fa" stroke-width="2" stroke-dasharray="10 8" opacity=".8"/>
           <text x="8" y="${(r as number) * CH - 6}" fill="#5ac8fa" font-size="18">${t}</text>`,
      )
      .join('');
    const ells = st.blurOn
      ? st.blurs
          .map((e, i) => {
            const rx = e.rx * s * settings.blurSize;
            const ry = e.ry * s * settings.blurSize;
            return `<ellipse cx="${e.cx * s + tx}" cy="${e.cy * s + ty}" rx="${rx}" ry="${ry}" fill="none"
              stroke="${i === selected ? '#ff9f0a' : '#0a84ff'}" stroke-width="${i === selected ? 4 : 2.5}" stroke-dasharray="8 6"/>`;
          })
          .join('')
      : '';
    svg.innerHTML = lines + ells;
    ($('#del') as HTMLButtonElement).disabled = selected < 0 || !st.blurOn;
  };
  const redraw = () => {
    if (!raf) raf = requestAnimationFrame(draw);
  };
  draw();

  // 画面座標 → 枠座標
  const toCell = (ev: PointerEvent) => {
    const r = cv.getBoundingClientRect();
    return { x: ((ev.clientX - r.left) / r.width) * CW, y: ((ev.clientY - r.top) / r.height) * CH };
  };
  const hit = (p: { x: number; y: number }) => {
    if (!st.blurOn) return -1;
    const { s, tx, ty } = transformOf(st, CW, CH, settings);
    for (let i = st.blurs.length - 1; i >= 0; i--) {
      const e = st.blurs[i];
      const rx = Math.max(30, e.rx * s * settings.blurSize);
      const ry = Math.max(30, e.ry * s * settings.blurSize);
      const dx = (p.x - (e.cx * s + tx)) / rx;
      const dy = (p.y - (e.cy * s + ty)) / ry;
      if (dx * dx + dy * dy <= 1) return i;
    }
    return -1;
  };

  const pts = new Map<number, { x: number; y: number }>();
  let pinch: { d: number; zoom: number; rx: number; ry: number } | null = null;
  let moved = false;
  let downHit = -1;
  const dist = () => {
    const [a, b] = [...pts.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  stage.onpointerdown = (ev) => {
    stage.setPointerCapture(ev.pointerId);
    pts.set(ev.pointerId, toCell(ev));
    if (pts.size === 1) {
      moved = false;
      downHit = hit(toCell(ev));
      if (downHit >= 0) selected = downHit;
      redraw();
    } else if (pts.size === 2) {
      const e = selected >= 0 ? st.blurs[selected] : null;
      pinch = { d: dist(), zoom: st.adj.zoom, rx: e?.rx ?? 0, ry: e?.ry ?? 0 };
    }
  };
  stage.onpointermove = (ev) => {
    const prev = pts.get(ev.pointerId);
    if (!prev) return;
    const p = toCell(ev);
    pts.set(ev.pointerId, p);
    if (pts.size === 2 && pinch) {
      const k = dist() / Math.max(1, pinch.d);
      if (selected >= 0) {
        st.blurs[selected].rx = pinch.rx * k;
        st.blurs[selected].ry = pinch.ry * k;
      } else {
        st.adj.zoom = Math.min(6, Math.max(0.3, pinch.zoom * k));
      }
      moved = true;
      redraw();
      return;
    }
    if (pts.size !== 1) return;
    const dx = p.x - prev.x;
    const dy = p.y - prev.y;
    if (Math.abs(dx) + Math.abs(dy) > 0.5) moved = true;
    if (downHit >= 0) {
      const { s } = transformOf(st, CW, CH, settings);
      st.blurs[downHit].cx += dx / s;
      st.blurs[downHit].cy += dy / s;
    } else {
      st.adj.dx += dx / CW;
      st.adj.dy += dy / CH;
    }
    redraw();
  };
  const up = (ev: PointerEvent) => {
    pts.delete(ev.pointerId);
    if (pts.size < 2) pinch = null;
    if (pts.size === 0) {
      if (!moved && downHit < 0) selected = -1; // 何もない所をタップ → 選択解除
      downHit = -1;
      redraw();
    }
  };
  stage.onpointerup = up;
  stage.onpointercancel = up;

  $<HTMLInputElement>('#blurOn').onchange = (e) => {
    st.blurOn = (e.target as HTMLInputElement).checked;
    redraw();
  };
  $('#add').onclick = () => {
    const { s, tx, ty } = transformOf(st, CW, CH, settings);
    const e: Ellipse = {
      cx: (CW / 2 - tx) / s,
      cy: (CH * 0.4 - ty) / s,
      rx: st.a.faceW * 0.17,
      ry: st.a.faceW * 0.1,
    };
    st.blurs.push(e);
    st.blurOn = true;
    $<HTMLInputElement>('#blurOn').checked = true;
    selected = st.blurs.length - 1;
    redraw();
  };
  $('#del').onclick = () => {
    if (selected < 0) return;
    st.blurs.splice(selected, 1);
    selected = -1;
    redraw();
  };
  $('#auto').onclick = () => {
    st.adj = { ...NO_ADJUST };
    st.blurs = st.a.eyes.map((e) => ({ ...e }));
    selected = -1;
    redraw();
  };
  $('#repick').onclick = async () => {
    const f = await pickFile();
    if (!f) return;
    currentScreen = 'home';
    await setPhoto(kind, f);
    if (slots[kind]) showEditor(kind);
  };
  $('#cancel').onclick = showHome;
  $('#done').onclick = () => {
    slots[kind] = st;
    reviewed.add(kind);
    showHome();
  };
}

// ---------- 画面4: 保存 ----------
async function exportImage() {
  const ov = h(`<div class="overlay"><div class="box">
    <p id="msg">高画質で書き出し中…</p><div class="progress" id="prog"><div></div></div>
    <div id="after" class="hidden">
      <button class="btn" id="share">写真に保存する</button>
      <button class="btn ghost" id="close">閉じる</button>
      <button class="btn ghost" id="newone">新しく作る</button>
    </div></div></div>`);
  document.body.append(ov);
  await new Promise((r) => setTimeout(r, 60));
  const o = outputSize(settings.ratio);
  const out = document.createElement('canvas');
  out.width = o.w;
  out.height = o.h;
  let file: File;
  try {
    renderCollage(out, slots, settings);
    const blob: Blob = await new Promise((res, rej) =>
      out.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), 'image/jpeg', 0.92),
    );
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const name = `monitor_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.jpg`;
    file = new File([blob], name, { type: 'image/jpeg' });
  } catch (e) {
    console.error(e);
    $('#msg', ov).textContent = '書き出しに失敗しました。もう一度お試しください。';
    $('#prog', ov).classList.add('hidden');
    $('#after', ov).classList.remove('hidden');
    $('#share', ov).classList.add('hidden');
    $('#close', ov).onclick = () => ov.remove();
    $('#newone', ov).classList.add('hidden');
    return;
  } finally {
    out.width = 0;
    out.height = 0;
  }
  $('#msg', ov).textContent = `書き出しが完了しました（${o.w}×${o.h}）`;
  $('#prog', ov).classList.add('hidden');
  $('#after', ov).classList.remove('hidden');
  const canShare = !!navigator.canShare?.({ files: [file] });
  if (!canShare) $('#share', ov).textContent = 'ダウンロードする';
  // 共有メニューは「タップした直後」でないと開けないため、ボタンを押してもらう
  $('#share', ov).onclick = async () => {
    if (canShare) {
      try {
        await navigator.share({ files: [file] });
      } catch {
        /* キャンセル */
      }
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file);
      a.download = file.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }
  };
  $('#close', ov).onclick = () => ov.remove();
  $('#newone', ov).onclick = () => {
    ov.remove();
    for (const k of KINDS) delete slots[k];
    reviewed.clear();
    showHome();
  };
}

// ---------- 画面5: 設定 ----------
function showSettings() {
  currentScreen = 'settings';
  app.replaceChildren(
    h(`<div class="bar"><div class="side"><button class="link" id="back">‹ 戻る</button></div>
      <div class="title">設定</div><div class="side r"></div></div>`),
    h(`<div class="list">
      <div class="row">出力サイズ（初期値）<div class="seg" id="ratio">
        <button data-r="16:9" class="${settings.ratio === '16:9' ? 'on' : ''}">16:9</button>
        <button data-r="3:2" class="${settings.ratio === '3:2' ? 'on' : ''}">3:2</button></div></div>
      <div class="row col"><div>顔の大きさ <span class="note" id="vFace"></span></div>
        <input type="range" id="face" min="0.6" max="0.9" step="0.01" value="${settings.faceSize}"></div>
      <div class="row col"><div>ぼかしの強さ <span class="note" id="vStr"></span></div>
        <input type="range" id="str" min="1" max="10" step="1" value="${settings.blurStrength}"></div>
      <div class="row col"><div>ぼかしの範囲 <span class="note" id="vSize"></span></div>
        <input type="range" id="size" min="0.6" max="1.6" step="0.05" value="${settings.blurSize}"></div>
      <div class="row">目元ぼかし（初期値）<label class="switch"><input type="checkbox" id="bd" ${settings.blurDefault ? 'checked' : ''}><span></span></label></div>
    </div>`),
    h(`<p class="note">設定はこの iPhone に保存され、次回も同じ設定で始まります。<br>顔の大きさ = 頭頂部〜顎先が枠の高さに占める割合です。</p>`),
    h(`<button class="btn ghost" id="resetSettings">初期設定に戻す</button>`),
  );
  const label = () => {
    $('#vFace').textContent = `${Math.round(settings.faceSize * 100)}%`;
    $('#vStr').textContent = String(settings.blurStrength);
    $('#vSize').textContent = `×${settings.blurSize.toFixed(2)}`;
  };
  label();
  const bind = (id: string, f: (v: number) => void) => {
    $<HTMLInputElement>(id).oninput = (e) => {
      f(Number((e.target as HTMLInputElement).value));
      saveSettings(settings);
      label();
    };
  };
  bind('#face', (v) => (settings.faceSize = v));
  bind('#str', (v) => (settings.blurStrength = v));
  bind('#size', (v) => (settings.blurSize = v));
  $<HTMLInputElement>('#bd').onchange = (e) => {
    settings.blurDefault = (e.target as HTMLInputElement).checked;
    saveSettings(settings);
  };
  $('#ratio').querySelectorAll('button').forEach((btn) => {
    btn.onclick = () => {
      settings.ratio = btn.dataset.r as Ratio;
      saveSettings(settings);
      showSettings();
    };
  });
  $('#resetSettings').onclick = () => {
    localStorage.removeItem('monitor-collage-settings-v1');
    Object.assign(settings, loadSettings());
    showSettings();
  };
  $('#back').onclick = showHome;
}

showHome();

// オフライン対応（本番のみ）
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register(BASE + 'sw.js').catch(console.error);
}

// 開発時のテスト用: テスト写真を URL から読み込む
if (import.meta.env.DEV) {
  (window as unknown as { __mc: unknown }).__mc = {
    async load(kind: Kind, url: string) {
      const b = await (await fetch(url)).blob();
      await setPhoto(kind, new File([b], url.split('/').pop()!, { type: b.type }));
    },
    slots,
    settings,
    showEditor,
    exportImage,
  };
}
