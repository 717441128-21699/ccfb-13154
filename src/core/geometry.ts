import type { Rect } from '../types';

/** 两矩形交集面积（输入为归一化坐标） */
export function intersectionArea(a: Rect, b: Rect): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x2 <= x1 || y2 <= y1) return 0;
  return (x2 - x1) * (y2 - y1);
}

/** 矩形并集面积 */
export function unionArea(a: Rect, b: Rect): number {
  return a.w * a.h + b.w * b.h - intersectionArea(a, b);
}

/** IoU 交并比 */
export function iou(a: Rect, b: Rect): number {
  const u = unionArea(a, b);
  return u === 0 ? 0 : intersectionArea(a, b) / u;
}

/** 判断两矩形是否重叠（任意面积相交即算） */
export function overlaps(a: Rect, b: Rect): boolean {
  return intersectionArea(a, b) > 0;
}

/** 矩形向外（或向内）膨胀 pad，结果夹紧在 [0,1] */
export function inflate(rect: Rect, padX: number, padY = padX): Rect {
  return {
    x: clamp(rect.x - padX, 0, 1),
    y: clamp(rect.y - padY, 0, 1),
    w: clamp(rect.w + padX * 2, 0, 1),
    h: clamp(rect.h + padY * 2, 0, 1),
  };
}

/** 限制取值范围 */
export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** 矩形中心 X */
export function centerX(r: Rect): number {
  return r.x + r.w / 2;
}

/** 矩形中心 Y */
export function centerY(r: Rect): number {
  return r.y + r.h / 2;
}

/**
 * 把网格单元矩形（col,row 起，cw 格宽、ch 格高）换算为归一化 Rect。
 */
export function cellRect(
  col: number,
  row: number,
  cw: number,
  ch: number,
  gridW: number,
  gridH: number,
): Rect {
  return {
    x: col / gridW,
    y: row / gridH,
    w: cw / gridW,
    h: ch / gridH,
  };
}

/** 计算 rect 在 saliency 网格上覆盖区域的平均显著度（0~1） */
export function meanSaliency(
  saliency: Float32Array,
  gw: number,
  gh: number,
  rect: Rect,
): number {
  const c0 = Math.max(0, Math.floor(rect.x * gw));
  const c1 = Math.min(gw - 1, Math.ceil((rect.x + rect.w) * gw) - 1);
  const r0 = Math.max(0, Math.floor(rect.y * gh));
  const r1 = Math.min(gh - 1, Math.ceil((rect.y + rect.h) * gh) - 1);
  if (c1 < c0 || r1 < r0) return 0;
  let sum = 0;
  let n = 0;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      sum += saliency[r * gw + c] ?? 0;
      n++;
    }
  }
  return n === 0 ? 0 : sum / n;
}

/** 计算 rect 在 saliency 网格上覆盖区域的显著度峰值 */
export function maxSaliency(
  saliency: Float32Array,
  gw: number,
  gh: number,
  rect: Rect,
): number {
  const c0 = Math.max(0, Math.floor(rect.x * gw));
  const c1 = Math.min(gw - 1, Math.ceil((rect.x + rect.w) * gw) - 1);
  const r0 = Math.max(0, Math.floor(rect.y * gh));
  const r1 = Math.min(gh - 1, Math.ceil((rect.y + rect.h) * gh) - 1);
  let max = 0;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const v = saliency[r * gw + c] ?? 0;
      if (v > max) max = v;
    }
  }
  return max;
}
