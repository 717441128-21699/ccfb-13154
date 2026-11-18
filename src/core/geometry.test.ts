import { describe, expect, it } from 'vitest';
import {
  clamp,
  inflate,
  intersectionArea,
  iou,
  maxSaliency,
  meanSaliency,
  overlaps,
} from './geometry';
import type { Rect } from '../types';

describe('geometry', () => {
  it('intersectionArea 基本重叠', () => {
    const a: Rect = { x: 0, y: 0, w: 0.5, h: 0.5 };
    const b: Rect = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
    expect(intersectionArea(a, b)).toBeCloseTo(0.25 * 0.25, 6);
  });

  it('不重叠时交集为 0', () => {
    const a: Rect = { x: 0, y: 0, w: 0.2, h: 0.2 };
    const b: Rect = { x: 0.8, y: 0.8, w: 0.2, h: 0.2 };
    expect(intersectionArea(a, b)).toBe(0);
    expect(overlaps(a, b)).toBe(false);
  });

  it('iou 恒等框为 1', () => {
    const a: Rect = { x: 0.1, y: 0.1, w: 0.3, h: 0.3 };
    expect(iou(a, { ...a })).toBeCloseTo(1, 10);
  });

  it('inflate 夹紧在 [0,1]', () => {
    const r = inflate({ x: 0, y: 0, w: 0.1, h: 0.1 }, 0.2);
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
    expect(r.w + r.x).toBeLessThanOrEqual(1);
  });

  it('clamp 边界', () => {
    expect(clamp(2, 0, 1)).toBe(1);
    expect(clamp(-1, 0, 1)).toBe(0);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });

  it('saliency 网格均值/峰值', () => {
    const gw = 4;
    const gh = 2;
    const sal = new Float32Array([0, 0, 1, 1, 0, 0, 1, 1]);
    const rect: Rect = { x: 0.5, y: 0, w: 0.5, h: 1 };
    expect(meanSaliency(sal, gw, gh, rect)).toBeCloseTo(1, 6);
    expect(maxSaliency(sal, gw, gh, rect)).toBe(1);
  });
});
