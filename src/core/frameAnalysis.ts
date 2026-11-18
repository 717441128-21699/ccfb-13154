import type { FrameAnalysis, Rect, TextBox } from '../types';
import { clamp } from './geometry';

/**
 * 画面分析器：在低分辨率灰度网格上计算
 * - 全帧亮度 / 亮度标准差（判断“太亮太花”）
 * - 边缘/笔画密度（文字与纹理的基础信号）
 * - 画面文字候选框（高密度单元膨胀 + 连通域 + 形态过滤）
 * - 显著图（中心先验 + 边缘 + 人脸/文字加权 + 平滑归一化）
 * - 帧间差分（镜头切换检测）
 *
 * 人脸由 MediaPipe 在 worker 中单独给出，本类只做纯像素统计，
 * 不依赖任何模型，便于单测。
 */

export const ANALYSIS_GRID_W = 20;
export const ANALYSIS_GRID_H = 36;

export interface RawFrameStats {
  luma: Float32Array;
  edge: Float32Array;
  meanLuma: number;
  lumaStd: number;
  /** 全帧边缘密度均值，供文字检测做自适应阈值 */
  edgeMean: number;
}

export class FrameFeatureExtractor {
  private canvas: OffscreenCanvas;
  private ctx: OffscreenCanvasRenderingContext2D;

  constructor() {
    this.canvas = new OffscreenCanvas(ANALYSIS_GRID_W, ANALYSIS_GRID_H);
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('无法创建 OffscreenCanvas 2D 上下文');
    this.ctx = ctx;
  }

  /** 从视频帧抽取网格统计 */
  extract(frame: VideoFrame): RawFrameStats {
    // VideoFrame 可直接绘制到 OffscreenCanvas
    this.ctx.drawImage(frame, 0, 0, ANALYSIS_GRID_W, ANALYSIS_GRID_H);
    const img = this.ctx.getImageData(0, 0, ANALYSIS_GRID_W, ANALYSIS_GRID_H);
    return statsFromRGBA(img.data);
  }

  /** 与 extract 相同的计算，但输入是普通 ImageData（测试/预览用） */
  extractFromImageData(data: Uint8Array, w: number, h: number): RawFrameStats {
    const img = new ImageData(new Uint8ClampedArray(data), w, h);
    const src = new OffscreenCanvas(w, h);
    const sctx = src.getContext('2d', { willReadFrequently: true })!;
    sctx.putImageData(img, 0, 0);
    this.ctx.drawImage(src, 0, 0, ANALYSIS_GRID_W, ANALYSIS_GRID_H);
    const out = this.ctx.getImageData(0, 0, ANALYSIS_GRID_W, ANALYSIS_GRID_H);
    return statsFromRGBA(out.data);
  }
}

/** 由 RGBA 像素计算 Rec.601 亮度网格与 Sobel 边缘密度 */
export function statsFromRGBA(rgba: Uint8ClampedArray): RawFrameStats {
  const n = ANALYSIS_GRID_W * ANALYSIS_GRID_H;
  const luma = new Float32Array(n);
  let sum = 0;

  for (let i = 0; i < n; i++) {
    const p = i * 4;
    // Rec.601 luma，归一化到 0~1
    const y = (0.299 * rgba[p]! + 0.587 * rgba[p + 1]! + 0.114 * rgba[p + 2]!) / 255;
    luma[i] = y;
    sum += y;
  }
  const meanLuma = sum / n;

  let varSum = 0;
  const edge = new Float32Array(n);
  let edgeSum = 0;
  for (let r = 0; r < ANALYSIS_GRID_H; r++) {
    for (let c = 0; c < ANALYSIS_GRID_W; c++) {
      const i = r * ANALYSIS_GRID_W + c;
      varSum += (luma[i]! - meanLuma) ** 2;
      if (r === 0 || c === 0 || r === ANALYSIS_GRID_H - 1 || c === ANALYSIS_GRID_W - 1) {
        edge[i] = 0;
        continue;
      }
      const gx =
        -luma[i - ANALYSIS_GRID_W - 1]! +
        luma[i - ANALYSIS_GRID_W + 1]! -
        2 * luma[i - 1]! +
        2 * luma[i + 1]! -
        luma[i + ANALYSIS_GRID_W - 1]! +
        luma[i + ANALYSIS_GRID_W + 1]!;
      const gy =
        -luma[i - ANALYSIS_GRID_W - 1]! -
        2 * luma[i - ANALYSIS_GRID_W]! -
        luma[i - ANALYSIS_GRID_W + 1]! +
        luma[i + ANALYSIS_GRID_W - 1]! +
        2 * luma[i + ANALYSIS_GRID_W]! +
        luma[i + ANALYSIS_GRID_W + 1]!;
      const e = Math.min(1, Math.hypot(gx, gy));
      edge[i] = e;
      edgeSum += e;
    }
  }
  // 边缘均值作为自适应阈值参考，避免对不同画面写死阈值
  const edgeMean = edgeSum / n;
  const lumaStd = Math.sqrt(varSum / n);
  return { luma, edge, meanLuma, lumaStd, edgeMean };
}

/** 帧间平均绝对亮度差（0~1），用于镜头切换 */
export function frameDifference(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / n;
}

/**
 * 画面文字检测：
 * 边缘密度高且局部明暗对比强的网格单元 -> 形态学膨胀 -> 连通域 -> 形态过滤。
 * 启发式方案，专门服务于“字幕不要盖住招牌/手机屏文字”的避让场景，
 * 召回优先：宁可多框一些高纹理区域让排版绕开，也不漏掉真文字。
 */
export function detectTextBoxes(stats: RawFrameStats): TextBox[] {
  const { luma, edge, edgeMean } = stats;
  const gw = ANALYSIS_GRID_W;
  const gh = ANALYSIS_GRID_H;
  const n = gw * gh;

  // 自适应阈值：1.8 倍平均边缘，绝对值下限取 0.05（网格分辨率低，Sobel 响应偏小）
  const edgeThr = Math.max(0.05, edgeMean * 1.8);

  const candidate = new Uint8Array(n);
  for (let r = 1; r < gh - 1; r++) {
    for (let c = 1; c < gw - 1; c++) {
      const i = r * gw + c;
      if (edge[i]! < edgeThr) continue;
      // 局部对比：3x3 邻域内 max-min，文字笔画必然伴随强明暗跳变
      let mn = 1;
      let mx = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const v = luma[(r + dr) * gw + (c + dc)]!;
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
      }
      if (mx - mn > 0.28) candidate[i] = 1;
    }
  }

  // 膨胀 1 格，把笔画单元连成斑块
  const dilated = new Uint8Array(n);
  for (let r = 0; r < gh; r++) {
    for (let c = 0; c < gw; c++) {
      if (!candidate[r * gw + c]) continue;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr >= 0 && rr < gh && cc >= 0 && cc < gw) dilated[rr * gw + cc] = 1;
        }
      }
    }
  }

  // 连通域（4-邻接，union-find）
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[x] !== root) {
      const next = parent[x]!;
      parent[x] = root;
      x = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  for (let r = 0; r < gh; r++) {
    for (let c = 0; c < gw; c++) {
      const i = r * gw + c;
      if (!dilated[i]) continue;
      if (c > 0 && dilated[i - 1]) union(i, i - 1);
      if (r > 0 && dilated[i - gw]) union(i, i - gw);
    }
  }

  // 汇总每个连通域的包围盒与得分
  interface Comp {
    minR: number; maxR: number; minC: number; maxC: number;
    cells: number; edgeSum: number;
  }
  const comps = new Map<number, Comp>();
  for (let r = 0; r < gh; r++) {
    for (let c = 0; c < gw; c++) {
      const i = r * gw + c;
      if (!dilated[i]) continue;
      const root = find(i);
      let comp = comps.get(root);
      if (!comp) {
        comp = { minR: r, maxR: r, minC: c, maxC: c, cells: 0, edgeSum: 0 };
        comps.set(root, comp);
      }
      comp.minR = Math.min(comp.minR, r);
      comp.maxR = Math.max(comp.maxR, r);
      comp.minC = Math.min(comp.minC, c);
      comp.maxC = Math.max(comp.maxC, c);
      comp.cells++;
      comp.edgeSum += edge[i]!;
    }
  }

  const boxes: TextBox[] = [];
  for (const comp of comps.values()) {
    const cwCells = comp.maxC - comp.minC + 1;
    const chCells = comp.maxR - comp.minR + 1;
    const fill = comp.cells / (cwCells * chCells);
    // 形态过滤：
    //  - 至少 3 个网格单元（滤噪点）
    //  - 宽不超过画面 95%、高不超过 65%（滤整块纹理背景）
    //  - 填充率 0.15~0.99（文字行斑块内部常因笔画间隙而不完全实心，
    //    但密集招牌/屏幕文字也可能接近实心，故上限放宽）
    //  - 高度至少 1 格（文字行有笔画厚度）
    if (comp.cells < 3) continue;
    if (cwCells / gw > 0.95 || chCells / gh > 0.8) continue;
    if (fill < 0.15 || fill > 0.995) continue;
    if (chCells < 1) continue;

    const rect: Rect = {
      x: clamp(comp.minC / gw - 0.015, 0, 1),
      y: clamp(comp.minR / gh - 0.012, 0, 1),
      w: clamp(cwCells / gw + 0.03, 0, 1),
      h: clamp(chCells / gh + 0.024, 0, 1),
    };
    boxes.push({ rect, score: comp.edgeSum / comp.cells });
  }

  // 合并高度重叠的相邻框（同一行招牌文字可能被切成几段）
  return mergeTextBoxes(boxes);
}

/** 合并垂直区间重叠且水平相邻的文字框 */
function mergeTextBoxes(boxes: TextBox[]): TextBox[] {
  const used = new Array(boxes.length).fill(false);
  const result: TextBox[] = [];

  for (let i = 0; i < boxes.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    let cur = { ...boxes[i]!.rect };
    let scoreAcc = boxes[i]!.score;
    let scoreN = 1;

    let changed = true;
    while (changed) {
      changed = false;
      for (let j = 0; j < boxes.length; j++) {
        if (used[j]) continue;
        const b = boxes[j]!.rect;
        const vOverlap =
          Math.min(cur.y + cur.h, b.y + b.h) - Math.max(cur.y, b.y);
        const vMin = Math.min(cur.h, b.h);
        const hGap = Math.max(b.x - (cur.x + cur.w), cur.x - (b.x + b.w));
        // 垂直重叠超过 50% 且水平间距小于 4% 画面宽度 -> 合并
        if (vOverlap / vMin > 0.5 && hGap < 0.04) {
          const x1 = Math.min(cur.x, b.x);
          const y1 = Math.min(cur.y, b.y);
          const x2 = Math.max(cur.x + cur.w, b.x + b.w);
          const y2 = Math.max(cur.y + cur.h, b.y + b.h);
          cur = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
          scoreAcc += boxes[j]!.score;
          scoreN++;
          used[j] = true;
          changed = true;
        }
      }
    }
    result.push({ rect: cur, score: scoreAcc / scoreN });
  }
  return result.sort((a, b) => b.score - a.score).slice(0, 12);
}

/**
 * 显著图：观众视线概率的先验估计。
 * 中心偏置 + 边缘密度 + 人脸/文字区域加权，再做盒式平滑并归一化。
 */
export function buildSaliency(
  stats: RawFrameStats,
  faces: FrameAnalysis['faces'],
  textBoxes: TextBox[],
): { saliency: Float32Array; w: number; h: number } {
  const gw = ANALYSIS_GRID_W;
  const gh = ANALYSIS_GRID_H;
  const n = gw * gh;
  const sal = new Float32Array(n);
  const cx = (gw - 1) / 2;
  const cy = (gh - 1) / 2;

  for (let r = 0; r < gh; r++) {
    for (let c = 0; c < gw; c++) {
      const i = r * gw + c;
      const nx = (c - cx) / cx;
      const ny = (r - cy) / cy;
      // 椭圆高斯中心先验
      const centerBias = Math.exp(-(nx * nx * 0.9 + ny * ny * 1.15));
      sal[i] = 0.45 * centerBias + 0.55 * stats.edge[i]!;
    }
  }

  const paint = (rect: Rect, weight: number) => {
    const c0 = Math.floor(rect.x * gw);
    const c1 = Math.ceil((rect.x + rect.w) * gw);
    const r0 = Math.floor(rect.y * gh);
    const r1 = Math.ceil((rect.y + rect.h) * gh);
    for (let r = r0; r < r1; r++) {
      for (let c = c0; c < c1; c++) {
        if (r >= 0 && r < gh && c >= 0 && c < gw) {
          sal[r * gw + c] = Math.min(1, sal[r * gw + c]! + weight);
        }
      }
    }
  };
  for (const f of faces) paint(f.rect, 0.6);
  for (const t of textBoxes) paint(t.rect, 0.45);

  // 3x3 盒式平滑
  const smoothed = new Float32Array(n);
  for (let r = 0; r < gh; r++) {
    for (let c = 0; c < gw; c++) {
      let s = 0;
      let cnt = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr >= 0 && rr < gh && cc >= 0 && cc < gw) {
            s += sal[rr * gw + cc]!;
            cnt++;
          }
        }
      }
      smoothed[r * gw + c] = s / cnt;
    }
  }

  // 归一化到 0~1
  let max = 1e-6;
  for (let i = 0; i < n; i++) if (smoothed[i]! > max) max = smoothed[i]!;
  for (let i = 0; i < n; i++) smoothed[i] = smoothed[i]! / max;

  return { saliency: smoothed, w: gw, h: gh };
}
