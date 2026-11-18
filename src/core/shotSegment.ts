import type { FrameAnalysis, Shot } from '../types';
import { frameDifference } from './frameAnalysis';
import { iou } from './geometry';

/**
 * 镜头分割：
 * 1. 硬切 —— 帧间亮度差分超过阈值；
 * 2. 辅助信号 —— 人脸集合发生突变（上一帧有人脸、下一帧人脸 IoU 全部对不上）。
 *
 * 返回的镜头按时间排序，并记录覆盖的分析帧下标区间。
 */
export function segmentShots(
  frames: FrameAnalysis[],
  diffThreshold: number,
  minShotFrames = 3,
): Shot[] {
  if (frames.length === 0) return [];

  const boundaries: number[] = [0];

  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1]!;
    const cur = frames[i]!;

    const diff = frameDifference(prev.luma, cur.luma);

    let hardCut = diff >= diffThreshold;

    // 人脸突变辅助判定（差分略低于阈值时也能切）
    if (!hardCut && (prev.faces.length > 0 || cur.faces.length > 0)) {
      const faceBreak = facesBreak(prev.faces, cur.faces);
      if (faceBreak && diff >= diffThreshold * 0.65) hardCut = true;
    }

    if (hardCut) boundaries.push(i);
  }

  // 合并过短镜头：少于 minShotFrames 的片段并入前一个
  const merged: number[] = [];
  for (const b of boundaries) {
    if (merged.length === 0) {
      merged.push(b);
      continue;
    }
    const prevB = merged[merged.length - 1]!;
    if (b - prevB < minShotFrames) continue;
    merged.push(b);
  }

  const shots: Shot[] = merged.map((frameStart, idx) => {
    const frameEnd =
      idx + 1 < merged.length ? merged[idx + 1]! - 1 : frames.length - 1;
    const start = frames[frameStart]!.time;
    const end = frames[frameEnd]!.time;
    return { id: idx, start, end, frameStart, frameEnd };
  });

  return shots;
}

/** 判断两帧的人脸集合是否完全对不上（机位/景别突变） */
function facesBreak(
  a: FrameAnalysis['faces'],
  b: FrameAnalysis['faces'],
): boolean {
  if (a.length === 0 && b.length === 0) return false;
  if (a.length === 0 || b.length === 0) return true;
  let matched = 0;
  for (const fa of a) {
    for (const fb of b) {
      if (iou(fa.rect, fb.rect) > 0.25) {
        matched++;
        break;
      }
    }
  }
  // 超过一半人脸对不上就算突变
  return matched < Math.max(1, Math.min(a.length, b.length) / 2);
}

/** 找到时间 t 所属的镜头（二分查找） */
export function shotAtTime(shots: Shot[], t: number): Shot | undefined {
  let lo = 0;
  let hi = shots.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = shots[mid]!;
    if (t < s.start) hi = mid - 1;
    else if (t > s.end) lo = mid + 1;
    else return s;
  }
  // 浮点边界兜底：取最近的镜头
  if (shots.length === 0) return undefined;
  if (lo >= shots.length) return shots[shots.length - 1];
  return shots[lo];
}
