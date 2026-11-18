import type { FrameAnalysis, Rect, SubtitleCue } from '../../types';
import { centerX } from '../geometry';

export interface SpeakerResult {
  /** 是否进入双人对话模式 */
  dialogue: boolean;
  /** 说话人人脸框（1~2 个），按画面左右排序 */
  speakers: Rect[];
  /** 本字幕主要说话人在 speakers 中的序号；单人时为 0，无法判定为 -1 */
  activeIndex: number;
}

/**
 * 说话人检测（纯视觉启发式，不依赖音轨）：
 * 1. 在字幕存活区间内统计稳定出现的人脸（按位置聚类）；
 * 2. 恰好两张脸且横向分立 -> 双人对话模式；
 * 3. 用“镜头内嘴部区域时间变化量”近似谁在说话：
 *    说话人嘴部边缘/亮度变化通常比沉默倾听者更剧烈。
 * 没有可靠信号时 activeIndex = -1，排版回退到居中。
 */
export function detectSpeaker(
  cue: SubtitleCue,
  frames: FrameAnalysis[],
  separation: number,
): SpeakerResult {
  const window = frames.filter(
    (f) => f.time >= cue.start - 0.001 && f.time <= cue.end + 0.001,
  );
  if (window.length === 0) {
    return { dialogue: false, speakers: [], activeIndex: -1 };
  }

  const clusters = clusterFaces(window);
  if (clusters.length === 0) {
    return { dialogue: false, speakers: [], activeIndex: -1 };
  }

  // 按出现帧数排序，取最稳定的两张
  clusters.sort((a, b) => b.frames.length - a.frames.length);
  const main = clusters.slice(0, 2).map((c) => averageRect(c.frames.map((f) => f.rect)));
  main.sort((a, b) => centerX(a) - centerX(b));

  if (main.length === 1) {
    return { dialogue: false, speakers: main, activeIndex: 0 };
  }

  const gap = Math.abs(centerX(main[0]!) - centerX(main[1]!));
  if (gap < separation) {
    // 两张脸挤在同一侧，不做左右对话处理
    return { dialogue: false, speakers: main, activeIndex: -1 };
  }

  const activeIndex = pickActiveSpeaker(clusters, window);
  return { dialogue: true, speakers: main, activeIndex };
}

interface FaceCluster {
  frames: FrameAnalysis['faces'];
}

/** 按相邻帧人脸 IoU 贪心聚类 */
function clusterFaces(frames: FrameAnalysis[]): FaceCluster[] {
  const clusters: { rect: Rect; frames: FrameAnalysis['faces'] }[] = [];

  for (const f of frames) {
    for (const face of f.faces) {
      if (face.confidence < 0.4) continue;
      let best = -1;
      let bestIou = 0.3;
      clusters.forEach((c, idx) => {
        const v = softIou(face.rect, c.rect);
        if (v > bestIou) {
          bestIou = v;
          best = idx;
        }
      });
      if (best >= 0) {
        const c = clusters[best]!;
        c.frames.push(face);
        c.rect = averageRect([c.rect, face.rect]);
      } else {
        clusters.push({ rect: { ...face.rect }, frames: [face] });
      }
    }
  }
  // 至少在 2 帧里出现才算稳定人脸
  return clusters.filter((c) => c.frames.length >= 2).map((c) => ({ frames: c.frames }));
}

function softIou(a: Rect, b: Rect): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union === 0 ? 0 : inter / union;
}

function averageRect(rects: Rect[]): Rect {
  let x = 0;
  let y = 0;
  let w = 0;
  let h = 0;
  for (const r of rects) {
    x += r.x;
    y += r.y;
    w += r.w;
    h += r.h;
  }
  const n = rects.length;
  return { x: x / n, y: y / n, w: w / n, h: h / n };
}

/**
 * 用嘴部区域的帧间变化量选说话人。
 * MediaPipe 检测器只给人脸框，嘴部约在人脸框下 1/4 区间，
 * 在该子区域累计边缘网格的时间差分，变化大的一方更可能在说话。
 */
function pickActiveSpeaker(
  clusters: FaceCluster[],
  frames: FrameAnalysis[],
): number {
  if (clusters.length < 2) return 0;
  const topTwo = clusters.slice(0, 2);
  const motion = topTwo.map((cluster) => {
    const rect = averageRect(cluster.frames.map((f) => f.rect));
    const mouth: Rect = {
      x: rect.x + rect.w * 0.15,
      y: rect.y + rect.h * 0.68,
      w: rect.w * 0.7,
      h: rect.h * 0.22,
    };
    let acc = 0;
    for (let i = 1; i < frames.length; i++) {
      acc += Math.abs(
        regionEdge(frames[i]!, mouth) - regionEdge(frames[i - 1]!, mouth),
      );
    }
    return acc;
  });

  const [a, b] = motion;
  // 差异不显著就不猜，交给居中兜底
  if (a === undefined || b === undefined) return -1;
  if (Math.abs(a - b) / Math.max(1e-6, a + b) < 0.12) return -1;
  return a > b ? 0 : 1;
}

function regionEdge(frame: FrameAnalysis, rect: Rect): number {
  const gw = frame.saliencyW;
  const gh = frame.saliencyH;
  const c0 = Math.max(0, Math.floor(rect.x * gw));
  const c1 = Math.min(gw - 1, Math.ceil((rect.x + rect.w) * gw) - 1);
  const r0 = Math.max(0, Math.floor(rect.y * gh));
  const r1 = Math.min(gh - 1, Math.ceil((rect.y + rect.h) * gh) - 1);
  let sum = 0;
  let n = 0;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      sum += frame.edge[r * gw + c] ?? 0;
      n++;
    }
  }
  return n === 0 ? 0 : sum / n;
}
