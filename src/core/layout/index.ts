import type {
  FrameAnalysis,
  LayoutOptions,
  LayoutResult,
  PlacedCue,
  Shot,
  SubtitleCue,
} from '../../types';
import { segmentShots, shotAtTime } from '../shotSegment';
import { countOverlapFrames, solveShot } from './solver';

export interface LayoutInput {
  width: number;
  height: number;
  duration: number;
  fps: number;
  frames: FrameAnalysis[];
  cues: SubtitleCue[];
  options: LayoutOptions;
}

/**
 * 排版主流程：
 * 镜头分割 -> 字幕按镜头分组 -> 各镜头内 DP 求解 -> 重叠验收。
 * 跨镜头的字幕按时间比例拆入对应镜头（ASS 中仍输出为一条 Dialogue，
 * 位置在镜头切点用两个事件表达，由导出器处理）。
 */
export function runLayout(input: LayoutInput): LayoutResult {
  const t0 = performance.now();
  const { frames, cues, options } = input;

  const shots: Shot[] = segmentShots(frames, options.shotChangeThreshold);
  const tSegment = performance.now();

  // 把每条字幕分配到其时间轴覆盖的镜头；跨镜头则拆分
  const byShot = new Map<number, SubtitleCue[]>();
  for (const cue of cues) {
    const startShot = shotAtTime(shots, cue.start);
    const endShot = shotAtTime(shots, cue.end);
    if (!startShot || !endShot) continue;

    if (startShot.id === endShot.id) {
      push(byShot, startShot.id, cue);
      continue;
    }
    // 跨镜头：在每个相关镜头内生成子片段（ASS 中输出为各自带位置的事件）
    for (const shot of shots) {
      if (shot.end < cue.start || shot.start > cue.end) continue;
      const part: SubtitleCue = {
        id: `${cue.id}@shot${shot.id}`,
        originalId: cue.id,
        start: Math.max(cue.start, shot.start),
        end: Math.min(cue.end, shot.end),
        text: cue.text,
      };
      push(byShot, shot.id, part);
    }
  }

  const placed: PlacedCue[] = [];
  for (const shot of shots) {
    const shotCues = byShot.get(shot.id) ?? [];
    if (shotCues.length === 0) continue;
    const result = solveShot(shot, shotCues, frames, options);
    placed.push(...result);
  }
  placed.sort((a, b) => a.cue.start - b.cue.start);
  const tLayout = performance.now();

  const { faceOverlapFrames, textOverlapFrames } = countOverlapFrames(placed, frames);

  return {
    width: input.width,
    height: input.height,
    duration: input.duration,
    fps: input.fps,
    options,
    shots,
    frames,
    placed,
    faceOverlapFrames,
    textOverlapFrames,
    timings: {
      segment: tSegment - t0,
      layout: tLayout - tSegment,
      total: tLayout - t0,
    },
  };
}

function push(map: Map<number, SubtitleCue[]>, id: number, cue: SubtitleCue): void {
  const arr = map.get(id);
  if (arr) arr.push(cue);
  else map.set(id, [cue]);
}
