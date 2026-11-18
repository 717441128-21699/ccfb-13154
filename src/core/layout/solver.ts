import type {
  FrameAnalysis,
  LayoutOptions,
  PlacedCue,
  Rect,
  Shot,
  SubtitleCue,
} from '../../types';
import { estimateCueBox, generateCandidates, type Candidate } from './candidates';
import {
  aggregateObstacles,
  collisionArea,
  needsBackground,
  preferenceCost,
  saliencyCost,
} from './obstacles';
import { detectSpeaker } from './speaker';

interface ScoredCandidate extends Candidate {
  cost: number;
  collision: number;
}

/**
 * 镜头内动态规划：
 * 节点 = 每条字幕的候选位置；边权 = 位置跳变代价。
 * DP 在“先保证零碰撞、再最小化总代价（显著度+偏好+跳变）”的序关系下
 * 求全局最优路径，从而实现“同一镜头里字幕位置不跳来跳去”。
 *
 * 序关系（字典序）：
 *   1) 碰撞面积越小越好（硬约束，权重远大于一切软代价）
 *   2) 软代价总和越小越好
 */
export function solveShot(
  shot: Shot,
  cues: SubtitleCue[],
  allFrames: FrameAnalysis[],
  opts: LayoutOptions,
): PlacedCue[] {
  if (cues.length === 0) return [];

  // 每个 cue 的候选及评分
  const layers: ScoredCandidate[][] = cues.map((cue) => {
    const speaker = detectSpeaker(cue, allFrames, opts.speakerSeparation);
    // 对话模式下统一用窄盒：能判出说话人则侧贴，否则居中窄盒
    const narrow = speaker.dialogue;
    const box0 = estimateCueBox(cue, opts, narrow);

    // 仅在明确判出说话人时才侧贴；否则给全部说话人位置（含居中兜底）
    const speakerRects = speaker.dialogue
      ? speaker.activeIndex >= 0
        ? [speaker.speakers[speaker.activeIndex]!]
        : speaker.speakers
      : speaker.speakers.length === 1
        ? speaker.speakers
        : [];

    const candidates = generateCandidates(box0, opts, speakerRects);
    const obs = aggregateObstacles(
      allFrames,
      cue.start,
      cue.end,
      opts.facePadding,
      opts.textPadding,
    );

    const scored: ScoredCandidate[] = candidates.map((cand) => {
      const collision = collisionArea(cand.box, obs);
      const sal = saliencyCost(cand.box, obs);
      const pref = preferenceCost(cand.box);
      // 绑定说话人的候选给予奖励（负代价），鼓励贴近说话人
      const speakerBonus =
        speaker.dialogue && cand.speaker === speaker.activeIndex ? -0.18 : 0;
      const cost =
        opts.saliencyWeight * sal +
        opts.preferenceWeight * pref +
        speakerBonus;
      return { ...cand, cost, collision };
    });

    // 挂到 cue 上供回溯阶段使用
    (cue as ScoredCue).__speaker = speaker;
    (cue as ScoredCue).__obsFrames = obs.frames;
    return scored;
  });

  // 碰撞的字典序权重：任何碰撞都比所有软代价之和更糟
  const COLLISION_WEIGHT = 1000;

  // dp[i][j] = 到达第 i 条字幕第 j 个候选的最小总代价与碰撞
  const dp: { total: number; collisionTotal: number; prev: number }[][] = [];
  layers.forEach((layer, i) => {
    dp[i] = layer.map((cand) => ({
      total: cand.cost + cand.collision * COLLISION_WEIGHT,
      collisionTotal: cand.collision,
      prev: -1,
    }));
  });

  for (let i = 1; i < layers.length; i++) {
    const cur = dp[i]!;
    const prev = dp[i - 1]!;
    const curLayer = layers[i]!;
    const prevLayer = layers[i - 1]!;
    for (let j = 0; j < cur.length; j++) {
      let bestTotal = Infinity;
      let bestPrev = 0;
      for (let k = 0; k < prev.length; k++) {
        const jump = jumpCost(prevLayer[k]!, curLayer[j]!, opts);
        const candidateTotal = prev[k]!.total + jump + curLayer[j]!.cost +
          curLayer[j]!.collision * COLLISION_WEIGHT;
        if (candidateTotal < bestTotal) {
          bestTotal = candidateTotal;
          bestPrev = k;
        }
      }
      cur[j]!.total = bestTotal;
      cur[j]!.prev = bestPrev;
      cur[j]!.collisionTotal =
        prev[bestPrev]!.collisionTotal + curLayer[j]!.collision;
    }
  }

  // 回溯
  const lastLayer = dp[dp.length - 1]!;
  let bestIdx = 0;
  for (let j = 1; j < lastLayer.length; j++) {
    if (lastLayer[j]!.total < lastLayer[bestIdx]!.total) bestIdx = j;
  }
  const chosen: number[] = new Array(layers.length).fill(0);
  chosen[chosen.length - 1] = bestIdx;
  for (let i = layers.length - 1; i > 0; i--) {
    chosen[i - 1] = dp[i]![chosen[i]!]!.prev;
  }

  return cues.map((cue, i) => {
    const cand = layers[i]![chosen[i]!]!;
    const speaker = (cue as ScoredCue).__speaker!;
    const obsFrames = (cue as ScoredCue).__obsFrames ?? [];
    const background = needsBackground(
      cand.box,
      obsFrames,
      opts.brightLumaThreshold,
      opts.busyTextureThreshold,
    );
    const reasons: string[] = [];
    if (cand.collision > 0) reasons.push('存在残留碰撞（候选区不足）');
    if (speaker.dialogue)
      reasons.push(
        cand.speaker >= 0 && cand.speaker === speaker.activeIndex
          ? '贴近说话人'
          : '双人对话',
      );
    reasons.push(background ? '局部过亮/过花，加底' : '底部安全区');

    return {
      cue,
      box: cand.box,
      anchorX: cand.anchorX,
      anchorY: cand.anchorY,
      background,
      reason: reasons.join('；'),
      overlapArea: cand.collision,
      shotId: shot.id,
      speakerFace: cand.speaker,
    } satisfies PlacedCue;
  });
}

/** 相邻字幕的位置跳变代价：纵向档位差为主，横向差为辅，换说话人时豁免 */
function jumpCost(a: Candidate, b: Candidate, opts: LayoutOptions): number {
  // 两条字幕分别绑定不同说话人时，横向移动是预期行为，只罚纵向
  const rowDiff = Math.abs(a.rowIndex - b.rowIndex);
  const colDiff = a.speaker !== -1 && b.speaker !== -1 && a.speaker !== b.speaker
    ? 0
    : Math.abs(a.colIndex - b.colIndex);
  const dy = Math.abs(a.box.y - b.box.y);
  return opts.jumpWeight * (rowDiff * 0.35 + colDiff * 0.2 + dy * 4);
}

interface ScoredCue extends SubtitleCue {
  __speaker?: ReturnType<typeof detectSpeaker>;
  __obsFrames?: FrameAnalysis[];
}

/** 计算最终结果里字幕与人脸/文字的重叠帧数量（验收指标） */
export function countOverlapFrames(
  placed: PlacedCue[],
  frames: FrameAnalysis[],
): { faceOverlapFrames: number; textOverlapFrames: number } {
  let faceOverlapFrames = 0;
  let textOverlapFrames = 0;

  for (const f of frames) {
    const active = placed.filter((p) => f.time >= p.cue.start && f.time <= p.cue.end);
    if (active.length === 0) continue;
    for (const p of active) {
      if (f.faces.some((face) => rectsIntersect(p.box, face.rect))) {
        faceOverlapFrames++;
        break;
      }
    }
    for (const p of active) {
      if (f.textBoxes.some((tb) => rectsIntersect(p.box, tb.rect))) {
        textOverlapFrames++;
        break;
      }
    }
  }
  return { faceOverlapFrames, textOverlapFrames };
}

function rectsIntersect(a: Rect, b: Rect): boolean {
  return !(
    a.x + a.w <= b.x ||
    b.x + b.w <= a.x ||
    a.y + a.h <= b.y ||
    b.y + b.h <= a.y
  );
}
