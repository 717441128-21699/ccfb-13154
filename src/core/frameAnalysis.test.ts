import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_GRID_H,
  ANALYSIS_GRID_W,
  buildSaliency,
  detectTextBoxes,
  frameDifference,
  statsFromRGBA,
} from './frameAnalysis';

describe('画面像素分析', () => {
  it('纯灰图像亮度一致、边缘为 0', () => {
    const n = ANALYSIS_GRID_W * ANALYSIS_GRID_H;
    const rgba = new Uint8ClampedArray(n * 4);
    rgba.fill(128);
    const stats = statsFromRGBA(rgba);
    expect(stats.meanLuma).toBeCloseTo(128 / 255, 2);
    expect(stats.lumaStd).toBeCloseTo(0, 4);
    expect(stats.edge.reduce((s, v) => s + v, 0)).toBe(0);
  });

  it('明暗棋盘格产生强边缘，文字检测能框出高对比区域', () => {
    const n = ANALYSIS_GRID_W * ANALYSIS_GRID_H;
    const rgba = new Uint8ClampedArray(n * 4);
    for (let r = 0; r < ANALYSIS_GRID_H; r++) {
      for (let c = 0; c < ANALYSIS_GRID_W; c++) {
        // 中部区域做 2x2 黑白棋盘格，模拟密集笔画（横竖都有梯度）
        const inside = r > 6 && r < 28 && c > 3 && c < 16;
        const checker = inside && ((Math.floor(r / 2) + Math.floor(c / 2)) % 2 === 0);
        const v = checker ? 255 : 20;
        const i = (r * ANALYSIS_GRID_W + c) * 4;
        rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
        rgba[i + 3] = 255;
      }
    }
    const stats = statsFromRGBA(rgba);
    const edgeTotal = stats.edge.reduce((s, v) => s + v, 0);
    expect(edgeTotal).toBeGreaterThan(0);

    const boxes = detectTextBoxes(stats);
    // 棋盘格区域应被识别为文字/高纹理候选（召回优先，至少框出一个）
    expect(boxes.length).toBeGreaterThan(0);
    for (const b of boxes) {
      expect(b.rect.w).toBeLessThanOrEqual(1);
      expect(b.rect.h).toBeLessThanOrEqual(1);
    }
  });

  it('帧间差分：相同帧为 0，反色帧接近 1', () => {
    const n = ANALYSIS_GRID_W * ANALYSIS_GRID_H;
    const a = new Float32Array(n).fill(0.2);
    const same = new Float32Array(n).fill(0.2);
    const inv = new Float32Array(n).fill(0.9);
    expect(frameDifference(a, same)).toBe(0);
    expect(frameDifference(a, inv)).toBeCloseTo(0.7, 5);
  });

  it('显著图归一化到 0~1 且人脸区域被加权', () => {
    const n = ANALYSIS_GRID_W * ANALYSIS_GRID_H;
    const stats = {
      luma: new Float32Array(n).fill(0.3),
      edge: new Float32Array(n),
      meanLuma: 0.3,
      lumaStd: 0,
      edgeMean: 0,
    };
    const sal = buildSaliency(
      stats,
      [{ rect: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, confidence: 0.9 }],
      [],
    );
    expect(sal.w).toBe(ANALYSIS_GRID_W);
    let max = 0;
    for (const v of sal.saliency) max = Math.max(max, v);
    expect(max).toBeCloseTo(1, 5);
  });
});
