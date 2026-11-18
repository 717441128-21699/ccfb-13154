import type { FaceObservation, FrameAnalysis, Rect, TextBox } from '../../types';
import { inflate, intersectionArea, maxSaliency, meanSaliency } from '../geometry';

/** 聚合后的障碍集合：字幕存活区间内所有需要避让的区域 */
export interface ObstacleSet {
  /** 膨胀后的人脸框（硬约束） */
  faces: Rect[];
  /** 膨胀后的画面文字框（硬约束） */
  textBoxes: Rect[];
  /** 区间内各帧的显著图（软约束，逐帧评分） */
  frames: FrameAnalysis[];
}

/**
 * 聚合 [start, end] 时间区间内所有分析帧上的障碍。
 * 人脸/文字框先膨胀安全余量再合并，保证字幕在整个存活期内都不会压到，
 * 而不是只在某一帧安全。这是“重叠帧数为零”的关键。
 */
export function aggregateObstacles(
  frames: FrameAnalysis[],
  start: number,
  end: number,
  facePad: number,
  textPad: number,
): ObstacleSet {
  const inRange = frames.filter((f) => f.time >= start - 0.001 && f.time <= end + 0.001);
  const window = inRange.length > 0 ? inRange : nearestFrames(frames, start, end);

  const faces: Rect[] = [];
  const textBoxes: Rect[] = [];
  for (const f of window) {
    for (const face of f.faces) {
      if (face.confidence < 0.4) continue;
      faces.push(inflate(face.rect, facePad, facePad * 1.2));
    }
    for (const tb of f.textBoxes) {
      textBoxes.push(inflate(tb.rect, textPad));
    }
  }

  return {
    faces: mergeOverlapping(faces, 0.3),
    textBoxes: mergeOverlapping(textBoxes, 0.3),
    frames: window,
  };
}

/** 区间内没有分析帧时（极端短字幕），取时间上最近的两帧兜底 */
function nearestFrames(frames: FrameAnalysis[], start: number, end: number): FrameAnalysis[] {
  if (frames.length === 0) return [];
  const mid = (start + end) / 2;
  const sorted = [...frames].sort(
    (a, b) => Math.abs(a.time - mid) - Math.abs(b.time - mid),
  );
  return sorted.slice(0, 2);
}

/** 合并高度重叠的同类框，降低候选评分时的重复计算 */
function mergeOverlapping(rects: Rect[], minIou: number): Rect[] {
  const kept: Rect[] = [];
  for (const r of rects) {
    const hit = kept.findIndex((k) => {
      const inter = intersectionArea(k, r);
      const smaller = Math.min(k.w * k.h, r.w * r.h);
      return smaller > 0 && inter / smaller > minIou;
    });
    if (hit >= 0) {
      kept[hit] = unionRect(kept[hit]!, r);
    } else {
      kept.push({ ...r });
    }
  }
  return kept;
}

function unionRect(a: Rect, b: Rect): Rect {
  const x1 = Math.min(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const x2 = Math.max(a.x + a.w, b.x + b.w);
  const y2 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** 硬约束：候选框与任何障碍相交即不合法，返回总重叠面积（0 表示安全） */
export function collisionArea(box: Rect, obs: ObstacleSet): number {
  let area = 0;
  for (const f of obs.faces) area += intersectionArea(box, f);
  for (const t of obs.textBoxes) area += intersectionArea(box, t);
  return area;
}

/** 软约束：候选框在存活区间内的平均显著度（越低越好） */
export function saliencyCost(box: Rect, obs: ObstacleSet): number {
  if (obs.frames.length === 0) return 0;
  let sum = 0;
  let peak = 0;
  for (const f of obs.frames) {
    const mean = meanSaliency(f.saliency, f.saliencyW, f.saliencyH, box);
    const max = maxSaliency(f.saliency, f.saliencyW, f.saliencyH, box);
    sum += mean;
    peak = Math.max(peak, max);
  }
  // 均值为主，峰值为辅：避免盖住任何一帧里的强焦点
  return (sum / obs.frames.length) * 0.7 + peak * 0.3;
}

/**
 * 位置偏好代价：竖屏短剧字幕默认偏好下 1/4 区域，
 * 越靠上代价越高（底部安全区是观众习惯的字幕带）。
 */
export function preferenceCost(box: Rect): number {
  const centerY = box.y + box.h / 2;
  // 0.78 是偏好带中心；距离越远代价越大，顶部最高
  const d = Math.abs(centerY - 0.82);
  return Math.min(1, d * 1.4);
}

/** 局部背景评估：判断字幕所在区域是否太亮或太花，需要加底 */
export function needsBackground(
  box: Rect,
  frames: FrameAnalysis[],
  brightThreshold: number,
  busyThreshold: number,
): boolean {
  if (frames.length === 0) return false;
  let brightVotes = 0;
  let busyVotes = 0;
  for (const f of frames) {
    const localLuma = regionMean(f.luma, f.saliencyW, f.saliencyH, box);
    const localEdge = regionMean(f.edge, f.saliencyW, f.saliencyH, box);
    if (localLuma > brightThreshold) brightVotes++;
    if (localEdge > busyThreshold) busyVotes++;
  }
  const ratio = 0.4;
  return (
    brightVotes / frames.length >= ratio || busyVotes / frames.length >= ratio
  );
}

function regionMean(
  grid: Float32Array,
  gw: number,
  gh: number,
  rect: Rect,
): number {
  const c0 = Math.max(0, Math.floor(rect.x * gw));
  const c1 = Math.min(gw - 1, Math.ceil((rect.x + rect.w) * gw) - 1);
  const r0 = Math.max(0, Math.floor(rect.y * gh));
  const r1 = Math.min(gh - 1, Math.ceil((rect.y + rect.h) * gh) - 1);
  let sum = 0;
  let n = 0;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      sum += grid[r * gw + c] ?? 0;
      n++;
    }
  }
  return n === 0 ? 0 : sum / n;
}

/** 取区间内置信度最高的若干人脸（说话人检测的输入） */
export function topFaces(frames: FrameAnalysis[], limit = 3): FaceObservation[] {
  const score = new Map<string, { face: FaceObservation; score: number; n: number }>();
  for (const f of frames) {
    f.faces.forEach((face, idx) => {
      const key = `${idx}-${Math.round(face.rect.x * 10)}-${Math.round(face.rect.y * 10)}`;
      const cur = score.get(key);
      if (cur) {
        cur.score += face.confidence;
        cur.n++;
      } else {
        score.set(key, { face, score: face.confidence, n: 1 });
      }
    });
  }
  return [...score.values()]
    .sort((a, b) => b.score / b.n - a.score / a.n)
    .slice(0, limit)
    .map((v) => v.face);
}

export type { TextBox };
