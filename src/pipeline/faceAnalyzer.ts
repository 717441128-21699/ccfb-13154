import { FaceDetector, FilesetResolver } from '@mediapipe/tasks-vision';
import type { FaceObservation } from '../types';

export interface FaceAnalyzerInit {
  /** 应用静态资源根 URL（主线程 document.baseURI），用于定位本地 WASM/模型 */
  assetBase: string;
}

/**
 * MediaPipe BlazeFace 封装。WASM 与模型优先从本地 public 目录加载，
 * 离线环境也可运行；本地缺失时回退到公网地址。
 * 设计为在 Web Worker 中运行，因此不访问 document。
 */
export class FaceAnalyzer {
  private detector: FaceDetector | null = null;

  async init(init: FaceAnalyzerInit): Promise<void> {
    const wasmPath = joinUrl(init.assetBase, 'mediapipe');
    const fileset = await FilesetResolver.forVisionTasks(
      wasmPath,
      // 传 true 加载 ESM 版 vision_wasm_module_internal.js（含 export default）。
      // 默认的 UMD 版没有 ESM 导出，在 module worker 里会触发
      // "ModuleFactory not set"。
      true,
    );
    const modelUrl = await this.resolveModelUrl(init.assetBase);
    this.detector = await FaceDetector.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: modelUrl,
        delegate: 'GPU',
      },
      runningMode: 'IMAGE',
      minDetectionConfidence: 0.5,
      minSuppressionThreshold: 0.3,
    });
  }

  /**
   * 检测一帧。MediaPipe 接受 VideoFrame（内部走 GPU 纹理），
   * 返回的 boundingBox 是像素坐标，这里归一化到 0~1。
   */
  detect(frame: VideoFrame, width: number, height: number): FaceObservation[] {
    if (!this.detector) throw new Error('FaceAnalyzer 尚未初始化');
    const result = this.detector.detect(frame);
    return result.detections.map((d) => {
      const b = d.boundingBox;
      return {
        rect: {
          x: clamp01((b?.originX ?? 0) / width),
          y: clamp01((b?.originY ?? 0) / height),
          w: clamp01((b?.width ?? 0) / width),
          h: clamp01((b?.height ?? 0) / height),
        },
        confidence: d.categories[0]?.score ?? 0.6,
      };
    });
  }

  private async resolveModelUrl(assetBase: string): Promise<string> {
    const local = joinUrl(assetBase, 'models/blaze_face_short_range.tflite');
    try {
      const head = await fetch(local, { method: 'HEAD' });
      if (head.ok) return local;
    } catch {
      // 离线或路径异常时回退到公网
    }
    return 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite';
  }

  dispose(): void {
    this.detector?.close();
    this.detector = null;
  }
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path}`;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
