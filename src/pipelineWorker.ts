import { Mp4Demuxer } from './pipeline/demuxer';
import { FrameDecoder } from './pipeline/decoder';
import { FaceAnalyzer } from './pipeline/faceAnalyzer';
import { FrameAnalysisPipeline } from './pipeline/analyze';
import { runLayout } from './core/layout';
import type { FrameAnalysis, LayoutResult } from './types';
import {
  toPreviewFrame,
  type WorkerRequest,
  type WorkerResponse,
} from './workerProtocol';

let cancelled = false;

function post(msg: WorkerResponse): void {
  self.postMessage(msg);
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  if (req.type === 'cancel') {
    cancelled = true;
    return;
  }
  if (req.type !== 'start') return;

  cancelled = false;
  const { file, cues, options, assetBase } = req;
  const timings: Record<string, number> = {};

  let demuxer: Mp4Demuxer | null = null;
  let decoder: FrameDecoder | null = null;
  let faces: FaceAnalyzer | null = null;

  try {
    post({ type: 'progress', phase: 'init', progress: 0.02, message: '初始化人脸模型…' });
    faces = new FaceAnalyzer();
    await faces.init({ assetBase });

    post({ type: 'progress', phase: 'demux', progress: 0.08, message: '解析 MP4 容器…' });
    const tDemux = performance.now();
    demuxer = new Mp4Demuxer();
    const demux = await demuxer.load(file);
    timings.demux = performance.now() - tDemux;

    post({
      type: 'progress',
      phase: 'decode',
      progress: 0.15,
      message: `浏览器硬解码中（${demux.videoTrack.codec}）…`,
    });

    const pipeline = new FrameAnalysisPipeline(faces);
    const analyzed: FrameAnalysis[] = [];
    let frameIndex = 0;
    const tDecode = performance.now();

    decoder = await FrameDecoder.create(
      demux.videoTrack,
      options.analysisFps,
      (frame, pts) => {
        // 每个抽帧：分析后立即释放 VideoFrame
        const analysis = pipeline.analyze(frame, frameIndex++, pts);
        analyzed.push(analysis);
        frame.close();
      },
      (p) => {
        const ratio = p.total === 0 ? 0 : p.samples / p.total;
        post({
          type: 'progress',
          phase: 'decode',
          progress: 0.15 + ratio * 0.55,
          message: `解码并分析帧 ${p.samples}/${p.total}`,
        });
      },
    );

    await decoder.decode(demuxer.samples);
    timings.decode = performance.now() - tDecode;

    if (cancelled) return;
    if (analyzed.length === 0) {
      throw new Error('没有解码出任何视频帧，请检查文件编码是否为 H.264/H.265');
    }

    post({
      type: 'progress',
      phase: 'segment',
      progress: 0.75,
      message: `镜头分割（${analyzed.length} 个分析帧）…`,
    });
    post({ type: 'framePreview', frames: analyzed.map(toPreviewFrame) });

    post({ type: 'progress', phase: 'layout', progress: 0.85, message: '字幕位置求解…' });
    const tLayout = performance.now();
    const result: LayoutResult = runLayout({
      width: demux.videoTrack.width,
      height: demux.videoTrack.height,
      duration: demux.durationSec,
      fps: options.analysisFps,
      frames: analyzed,
      cues,
      options,
    });
    timings.layoutTotal = performance.now() - tLayout;
    result.timings = { ...timings, ...result.timings };

    post({ type: 'progress', phase: 'layout', progress: 1, message: '完成' });
    post({
      type: 'done',
      result: {
        ...result,
        frames: analyzed.map(toPreviewFrame),
      },
    });
  } catch (err) {
    post({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    decoder?.dispose();
    demuxer?.dispose();
    faces?.dispose();
  }
};
