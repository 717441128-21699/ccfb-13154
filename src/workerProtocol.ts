import type { FrameAnalysis, LayoutOptions, LayoutResult, SubtitleCue } from './types';

/** 主线程 -> Worker 的消息 */
export type WorkerRequest =
  | {
      type: 'start';
      /** 视频文件（结构化克隆传输） */
      file: File;
      cues: SubtitleCue[];
      options: LayoutOptions;
      assetBase: string;
    }
  | { type: 'cancel' };

/** Worker -> 主线程的消息 */
export type WorkerResponse =
  | {
      type: 'progress';
      phase: 'init' | 'demux' | 'decode' | 'analyze' | 'segment' | 'layout';
      progress: number;
      message: string;
    }
  | {
      type: 'framePreview';
      /** 抽样的分析帧（轻量字段，用于前端绘制调试叠加层） */
      frames: PreviewFrame[];
    }
  | {
      type: 'done';
      /** 完整结果（不含大体积网格，网格按需通过 preview 提供） */
      result: TransferableLayoutResult;
    }
  | { type: 'error'; message: string };

export type WorkerProgress = Extract<WorkerResponse, { type: 'progress' }>;

/** 可结构化克隆的精简分析帧 */
export interface PreviewFrame {
  time: number;
  index: number;
  faces: FrameAnalysis['faces'];
  textBoxes: FrameAnalysis['textBoxes'];
  meanLuma: number;
  lumaStd: number;
}

export type TransferableLayoutResult = Omit<LayoutResult, 'frames'> & {
  frames: PreviewFrame[];
};

export function toPreviewFrame(f: FrameAnalysis): PreviewFrame {
  return {
    time: f.time,
    index: f.index,
    faces: f.faces,
    textBoxes: f.textBoxes,
    meanLuma: f.meanLuma,
    lumaStd: f.lumaStd,
  };
}
