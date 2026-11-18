import { describe, expect, it } from 'vitest';
import type { FrameAnalysis, LayoutOptions, Shot, SubtitleCue } from '../types';
import { DEFAULT_LAYOUT_OPTIONS } from '../types';
import { runLayout } from './layout';
import type { Rect } from '../types';

/** 构造一帧合成分析数据（无像素，直接给网格） */
function makeFrame(
  time: number,
  index: number,
  faces: FrameAnalysis['faces'] = [],
  textBoxes: FrameAnalysis['textBoxes'] = [],
): FrameAnalysis {
  const w = 20;
  const h = 36;
  const n = w * h;
  return {
    time,
    index,
    faces,
    textBoxes,
    luma: new Float32Array(n).fill(0.3),
    edge: new Float32Array(n),
    saliency: new Float32Array(n).fill(0.2),
    saliencyW: w,
    saliencyH: h,
    meanLuma: 0.3,
    lumaStd: 0.05,
  };
}

function faceRect(x: number, y: number, w = 0.2, h = 0.25, conf = 0.9) {
  return { rect: { x, y, w, h }, confidence: conf };
}

function makeCues(count: number, start = 0, gap = 3, dur = 2.5): SubtitleCue[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `cue-${i + 1}`,
    start: start + i * gap,
    end: start + i * gap + dur,
    text: `这是第${i + 1}句测试台词，需要自动避开人脸`,
  }));
}

describe('排版集成：零人脸重叠', () => {
  const opts: LayoutOptions = { ...DEFAULT_LAYOUT_OPTIONS };

  it('人脸固定在画面底部时，字幕不会压到人脸', () => {
    // 30 秒、4fps = 120 帧；一张大脸常驻底部 0.72~0.97
    const frames: FrameAnalysis[] = [];
    for (let i = 0; i < 120; i++) {
      frames.push(
        makeFrame(i / 4, i, [faceRect(0.25, 0.72, 0.5, 0.25)]),
      );
    }
    const cues = makeCues(6);
    const result = runLayout({
      width: 1080,
      height: 1920,
      duration: 30,
      fps: 4,
      frames,
      cues,
      options: opts,
    });

    expect(result.faceOverlapFrames).toBe(0);
    expect(result.placed.length).toBeGreaterThan(0);
    // 所有字幕框必须位于人脸上方
    for (const p of result.placed) {
      expect(p.box.y + p.box.h).toBeLessThanOrEqual(0.72 + 1e-6);
    }
  });

  it('画面文字（招牌）出现在上部时，字幕避开该区域', () => {
    const sign: Rect = { x: 0.1, y: 0.08, w: 0.8, h: 0.12 };
    const frames: FrameAnalysis[] = [];
    for (let i = 0; i < 80; i++) {
      frames.push(makeFrame(i / 4, i, [], [{ rect: sign, score: 0.8 }]));
    }
    const cues = makeCues(4);
    const result = runLayout({
      width: 1080,
      height: 1920,
      duration: 20,
      fps: 4,
      frames,
      cues,
      options: opts,
    });
    expect(result.textOverlapFrames).toBe(0);
    for (const p of result.placed) {
      // 字幕不应伸入招牌区
      const intersects =
        p.box.x < sign.x + sign.w &&
        p.box.x + p.box.w > sign.x &&
        p.box.y < sign.y + sign.h &&
        p.box.y + p.box.h > sign.y;
      expect(intersects).toBe(false);
    }
  });

  it('同一镜头内相邻字幕纵向位置保持稳定（不跳来跳去）', () => {
    const frames: FrameAnalysis[] = [];
    for (let i = 0; i < 120; i++) frames.push(makeFrame(i / 4, i));
    const cues = makeCues(6, 0, 3, 2);
    const result = runLayout({
      width: 1080,
      height: 1920,
      duration: 30,
      fps: 4,
      frames,
      cues,
      options: opts,
    });
    // 无障碍场景：全部字幕应落在同一个纵向档位
    const ys = new Set(result.placed.map((p) => Math.round(p.box.y * 1000)));
    expect(ys.size).toBe(1);
  });

  it('双人左右分立时进入对话模式，字幕向说话人一侧收缩', () => {
    const frames: FrameAnalysis[] = [];
    for (let i = 0; i < 60; i++) {
      frames.push(
        makeFrame(i / 4, i, [
          faceRect(0.05, 0.3, 0.22, 0.28),
          faceRect(0.73, 0.3, 0.22, 0.28),
        ]),
      );
    }
    const cues: SubtitleCue[] = [
      { id: 'a', start: 0.5, end: 2.5, text: '左边的人在说话' },
      { id: 'b', start: 3, end: 5, text: '右边的人回应了一句' },
    ];
    const result = runLayout({
      width: 1080,
      height: 1920,
      duration: 15,
      fps: 4,
      frames,
      cues,
      options: { ...opts, speakerSeparation: 0.28 },
    });
    expect(result.faceOverlapFrames).toBe(0);
    // 对话模式下字幕盒宽度应窄于普通模式
    for (const p of result.placed) {
      expect(p.box.w).toBeLessThanOrEqual(
        opts.maxTextWidthRatio * opts.dialogueWidthRatio + 1e-6,
      );
    }
  });

  it('镜头硬切被正确分割', () => {
    const frames: FrameAnalysis[] = [];
    for (let i = 0; i < 40; i++) {
      const f = makeFrame(i / 4, i);
      // 第 20 帧前后制造亮度突变
      if (i >= 20) f.luma.fill(0.85);
      frames.push(f);
    }
    const result = runLayout({
      width: 1080,
      height: 1920,
      duration: 10,
      fps: 4,
      frames,
      cues: makeCues(2),
      options: opts,
    });
    expect(result.shots.length).toBeGreaterThanOrEqual(2);
  });
});

describe('镜头分割单元', () => {
  it('无差异帧序列只产生一个镜头', () => {
    const frames: FrameAnalysis[] = [];
    for (let i = 0; i < 20; i++) frames.push(makeFrame(i / 4, i));
    const result = runLayout({
      width: 1080,
      height: 1920,
      duration: 5,
      fps: 4,
      frames,
      cues: [],
      options: DEFAULT_LAYOUT_OPTIONS,
    });
    const shots: Shot[] = result.shots;
    expect(shots.length).toBe(1);
  });
});
