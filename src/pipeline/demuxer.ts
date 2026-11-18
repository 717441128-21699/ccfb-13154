import { createFile, type ISOFile, type Movie, type Sample } from 'mp4box';

export interface DemuxedTrack {
  id: number;
  codec: string;
  width: number;
  height: number;
  timescale: number;
  duration: number;
  /** WebCodecs VideoDecoderConfig 所需的 codec-specific description */
  description: Uint8Array | undefined;
}

export interface DemuxResult {
  movie: Movie;
  videoTrack: DemuxedTrack;
  durationSec: number;
}

/**
 * MP4 解封装器：把 File/Blob 流式喂给 mp4box，
 * 提取视频轨道的全部压缩样本交给 WebCodecs 解码。
 * 支持 moov 在文件尾部的情况（mp4box 内部会回退重读）。
 */
export class Mp4Demuxer {
  private file: ISOFile;
  private videoSamples: Sample[] = [];
  private readyResolvers: {
    resolve: (r: DemuxResult) => void;
    reject: (e: Error) => void;
  } | null = null;

  constructor() {
    this.file = createFile();
    this.file.onError = (module, message) => {
      this.readyResolvers?.reject(new Error(`mp4box ${module}: ${message}`));
    };
    this.file.onReady = (movie: Movie) => {
      const video = movie.videoTracks[0];
      if (!video) {
        this.readyResolvers?.reject(new Error('文件中没有视频轨道'));
        return;
      }
      this.file.setExtractionOptions(video.id, { trackId: video.id }, { nbSamples: 200 });
      this.file.start();
      const desc = extractCodecDescription(this.file);
      const result: DemuxResult = {
        movie,
        videoTrack: {
          id: video.id,
          codec: video.codec,
          width: video.track_width,
          height: video.track_height,
          timescale: video.timescale,
          duration: video.duration,
          description: desc,
        },
        durationSec: movie.duration / movie.timescale,
      };
      this.readyResolvers?.resolve(result);
    };
    this.file.onSamples = (_id, _user, samples) => {
      this.videoSamples.push(...samples);
    };
  }

  /** 读入整个文件并等待 moov 解析完成 */
  async load(blob: Blob): Promise<DemuxResult> {
    const ready = new Promise<DemuxResult>((resolve, reject) => {
      this.readyResolvers = { resolve, reject };
    });

    // 按 4MB 分块顺序读入，避免一次性占用大块内存
    const CHUNK = 4 * 1024 * 1024;
    let pos = 0;
    while (pos < blob.size) {
      const buf = await blob.slice(pos, Math.min(pos + CHUNK, blob.size)).arrayBuffer();
      // mp4box 的 MP4BoxBuffer 在 ArrayBuffer 上附带 fileStart 字段；
      // buf 会被接管，这里复制一份再喂入
      const mp4buf = buf.slice(0) as ArrayBuffer & { fileStart: number };
      mp4buf.fileStart = pos;
      this.file.appendBuffer(mp4buf);
      pos += buf.byteLength;
    }
    this.file.flush();

    const result = await ready;
    // flush 后 onSamples 可能仍在事件循环中，等样本排空
    await new Promise((r) => setTimeout(r, 0));
    return result;
  }

  get samples(): Sample[] {
    return this.videoSamples;
  }

  /** 样本的呈现时间（秒） */
  samplePts(sample: Sample, track: DemuxedTrack): number {
    const pts = sample.pts ?? sample.cts ?? sample.dts;
    return pts / track.timescale;
  }

  dispose(): void {
    try {
      this.file.stop();
    } catch {
      // 忽略重复停止
    }
    this.videoSamples = [];
  }
}

/**
 * 从 mp4box 的完整 box 树中取出 codec-specific 描述，
 * 作为 VideoDecoderConfig.description（EncodedVideoChunk 之外的初始化数据）。
 *
 * mp4box 2.x 的 onReady Track 是扁平摘要、不含 box 树，
 * 真正的 avcC/hvcC 挂在 file.moov.traks[*].samples[0].description.boxes 下，
 * 且 avcC 的 SPS/PPS 是结构化字段而非整段字节，需要按 ISO 14496-15 重新拼装。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractCodecDescription(file: ISOFile): Uint8Array | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const traks: any[] = file.moov?.traks ?? [];
  for (const trak of traks) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sample: any = trak?.samples?.[0] ?? trak?.mdia?.minf?.stbl?.stsd?.entries?.[0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const boxes: any[] | undefined = sample?.description?.boxes ?? sample?.boxes;
    if (!Array.isArray(boxes)) continue;

    const avcC = boxes.find((b) => b?.type === 'avcC');
    if (avcC) return buildAvcC(avcC);
    const hvcC = boxes.find((b) => b?.type === 'hvcC');
    if (hvcC) return boxBytes(hvcC) ?? buildHvcC(hvcC);
    const av1C = boxes.find((b) => b?.type === 'av1C');
    if (av1C) return boxBytes(av1C);
    const vpcC = boxes.find((b) => b?.type === 'vpcC');
    if (vpcC) return boxBytes(vpcC);
  }
  return undefined;
}

/** 按 ISO 14496-15 5.2.4.1 拼装 AVC Decoder Configuration Record */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildAvcC(avcC: any): Uint8Array | undefined {
  const sps: Uint8Array[] = (avcC?.SPS ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((n: any) => n?.data)
    .filter((d: unknown): d is Uint8Array => d instanceof Uint8Array);
  const pps: Uint8Array[] = (avcC?.PPS ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((n: any) => n?.data)
    .filter((d: unknown): d is Uint8Array => d instanceof Uint8Array);
  if (sps.length === 0 || pps.length === 0) return boxBytes(avcC);

  const parts: number[] = [
    1, // configurationVersion
    avcC.AVCProfileIndication ?? 66,
    avcC.profile_compatibility ?? 0,
    avcC.AVCLevelIndication ?? 30,
    0xff, // lengthSizeMinusOne=3（NALU 长度 4 字节）| 0b11111100
    0xe0 | (sps.length & 0x1f), // 0b111 + SPS 个数
  ];
  for (const s of sps) {
    parts.push((s.length >> 8) & 0xff, s.length & 0xff);
    parts.push(...s);
  }
  parts.push(pps.length & 0xff);
  for (const p of pps) {
    parts.push((p.length >> 8) & 0xff, p.length & 0xff);
    parts.push(...p);
  }
  return Uint8Array.from(parts);
}

/** HEVC 配置结构更复杂，优先取 mp4box 已序列化的字节；缺失时返回 undefined */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildHvcC(_hvcC: any): Uint8Array | undefined {
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function boxBytes(box: any): Uint8Array | undefined {
  if (!box) return undefined;
  if (box instanceof Uint8Array) return box;
  if (box.data instanceof Uint8Array) return box.data;
  return undefined;
}
