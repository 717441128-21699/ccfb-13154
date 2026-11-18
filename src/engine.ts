import type { LayoutOptions, SubtitleCue } from './types';
import type {
  PreviewFrame,
  TransferableLayoutResult,
  WorkerProgress,
  WorkerRequest,
  WorkerResponse,
} from './workerProtocol';

export interface EngineCallbacks {
  onProgress: (p: WorkerProgress) => void;
  onFramePreview: (frames: PreviewFrame[]) => void;
  onDone: (result: TransferableLayoutResult) => void;
  onError: (message: string) => void;
}

/**
 * 主线程侧引擎：负责 Worker 生命周期与消息转发，
 * 所有重活都在 worker 中执行，UI 不卡顿。
 */
export class LayoutEngine {
  private worker: Worker | null = null;

  start(
    file: File,
    cues: SubtitleCue[],
    options: LayoutOptions,
    callbacks: EngineCallbacks,
  ): void {
    this.stop();
    this.worker = new Worker(new URL('./pipelineWorker.ts', import.meta.url), {
      type: 'module',
    });

    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      switch (msg.type) {
        case 'progress':
          callbacks.onProgress(msg);
          break;
        case 'framePreview':
          callbacks.onFramePreview(msg.frames);
          break;
        case 'done':
          callbacks.onDone(msg.result);
          break;
        case 'error':
          callbacks.onError(msg.message);
          break;
      }
    };
    this.worker.onerror = (ev) => callbacks.onError(ev.message);

    this.worker.postMessage({
      type: 'start',
      file,
      cues,
      options,
      assetBase: document.baseURI,
    } satisfies WorkerRequest);
  }

  stop(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}
