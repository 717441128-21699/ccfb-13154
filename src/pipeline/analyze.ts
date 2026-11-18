import type { FrameAnalysis } from '../types';
import {
  ANALYSIS_GRID_W,
  ANALYSIS_GRID_H,
  FrameFeatureExtractor,
  buildSaliency,
  detectTextBoxes,
} from '../core/frameAnalysis';
import type { FaceAnalyzer } from './faceAnalyzer';

/**
 * 单帧分析编排：像素统计（亮度/边缘/文字/显著图）+ 人脸检测，
 * 输出统一的 FrameAnalysis。VideoFrame 由调用方负责 close。
 */
export class FrameAnalysisPipeline {
  private features = new FrameFeatureExtractor();

  constructor(private faceAnalyzer: FaceAnalyzer) {}

  analyze(frame: VideoFrame, index: number, time: number): FrameAnalysis {
    const width = frame.displayWidth;
    const height = frame.displayHeight;

    const stats = this.features.extract(frame);
    const textBoxes = detectTextBoxes(stats);
    const faces = this.faceAnalyzer.detect(frame, width, height);
    const sal = buildSaliency(stats, faces, textBoxes);

    return {
      time,
      index,
      faces,
      textBoxes,
      luma: stats.luma,
      edge: stats.edge,
      saliency: sal.saliency,
      saliencyW: sal.w ?? ANALYSIS_GRID_W,
      saliencyH: sal.h ?? ANALYSIS_GRID_H,
      meanLuma: stats.meanLuma,
      lumaStd: stats.lumaStd,
    };
  }
}

export { ANALYSIS_GRID_W, ANALYSIS_GRID_H };
