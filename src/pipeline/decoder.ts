import type { DemuxedTrack } from './demuxer';
import type { Sample } from 'mp4box';

export interface DecodeProgress {
  /** 已处理样本数 */
  samples: number;
  total: number;
}

/**
 * WebCodecs 硬解码器封装：
 * 按 dts 顺序喂入 EncodedVideoChunk，按目标分析帧率抽帧，
 * 其余帧直接 close 释放。所有解码在浏览器原生线程完成，不阻塞主线程。
 */
export class FrameDecoder {
  private decoder: VideoDecoder;
  private track: DemuxedTrack;
  private frameInterval: number;
  private lastEmitPts = -Infinity;
  private decodedCount = 0;
  private totalSamples = 0;
  private onFrame: (frame: VideoFrame, pts: number) => void;
  private onProgress?: (p: DecodeProgress) => void;
  private errorPromise: Promise<never>;
  private rejectError!: (err: Error) => void;

  private constructor(
    track: DemuxedTrack,
    analysisFps: number,
    onFrame: (frame: VideoFrame, pts: number) => void,
    onProgress?: (p: DecodeProgress) => void,
  ) {
    this.track = track;
    this.onFrame = onFrame;
    this.onProgress = onProgress;
    this.frameInterval = 1 / analysisFps;

    // 解码器内部错误通过 Promise 暴露，decode() 中可被 await 拒绝
    this.errorPromise = new Promise<never>((_, reject) => {
      this.rejectError = reject;
    });
    // 防止未消费时产生 unhandled rejection 警告
    this.errorPromise.catch(() => {});

    this.decoder = new VideoDecoder({
      output: (frame) => this.handleOutput(frame),
      error: (err) => this.rejectError(new Error(`VideoDecoder 错误: ${err.message}`)),
    });
  }

  /** 异步工厂：先确认浏览器支持该 codec，再配置解码器 */
  static async create(
    track: DemuxedTrack,
    analysisFps: number,
    onFrame: (frame: VideoFrame, pts: number) => void,
    onProgress?: (p: DecodeProgress) => void,
  ): Promise<FrameDecoder> {
    const config: VideoDecoderConfig = {
      codec: track.codec,
      codedWidth: track.width,
      codedHeight: track.height,
      optimizeForLatency: false,
    };
    if (track.description) {
      config.description = track.description as BufferSource;
    }
    const support = await checkSupport(config);
    if (!support) {
      throw new Error(
        `当前浏览器不支持解码 ${track.codec}（${track.width}x${track.height}），请使用最新版 Chrome/Edge`,
      );
    }
    const decoder = new FrameDecoder(track, analysisFps, onFrame, onProgress);
    decoder.decoder.configure(config);
    return decoder;
  }

  /** 解码全部样本；仅保留间隔 >= 1/analysisFps 的帧 */
  async decode(samples: Sample[]): Promise<void> {
    this.totalSamples = samples.length;
    for (const sample of samples) {
      if (!sample.data) continue;

      // 控制在途解码队列长度，防止显存堆积；同时监听解码器致命错误
      while (this.decoder.decodeQueueSize > 8) {
        await Promise.race([this.waitForSlot(), this.errorPromise]);
      }

      const chunk = new EncodedVideoChunk({
        type: sample.is_sync ? 'key' : 'delta',
        timestamp: Math.round((sample.dts / this.track.timescale) * 1e6),
        duration: Math.round((sample.duration / this.track.timescale) * 1e6),
        data: sample.data,
      });
      this.decoder.decode(chunk);
      this.onProgress?.({ samples: this.decodedCount, total: this.totalSamples });
    }
    await Promise.race([this.decoder.flush(), this.errorPromise]);
  }

  private handleOutput(frame: VideoFrame): void {
    this.decodedCount++;
    const pts = frame.timestamp / 1e6;
    if (pts - this.lastEmitPts >= this.frameInterval - 1e-4) {
      this.lastEmitPts = pts;
      this.onFrame(frame, pts);
    } else {
      frame.close();
    }
    this.onProgress?.({ samples: this.decodedCount, total: this.totalSamples });
  }

  private waitForSlot(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.decoder.decodeQueueSize <= 4) resolve();
        else setTimeout(check, 4);
      };
      check();
    });
  }

  get state(): string {
    return this.decoder.state;
  }

  dispose(): void {
    try {
      if (this.decoder.state === 'configured') this.decoder.reset();
      if (this.decoder.state !== 'closed') this.decoder.close();
    } catch {
      // 已关闭或释放，忽略
    }
  }
}

async function checkSupport(config: VideoDecoderConfig): Promise<boolean> {
  if (typeof VideoDecoder === 'undefined' || !('isConfigSupported' in VideoDecoder)) {
    return false;
  }
  try {
    const r = await VideoDecoder.isConfigSupported(config);
    return r.supported === true;
  } catch {
    return false;
  }
}
