// Node 环境验证 mp4box 解封装与 avcC 重建（与 demuxer.ts 同构）
import { readFile } from 'node:fs/promises';
import { createFile } from 'mp4box';

const file = process.argv[2];
if (!file) {
  console.error('用法: node scripts/verify-demux.mjs <video.mp4>');
  process.exit(1);
}

const buf = await readFile(file);
const mp4 = createFile();
const samples = [];

function buildAvcC(avcC) {
  const sps = (avcC?.SPS ?? []).map((n) => n?.data).filter((d) => d instanceof Uint8Array);
  const pps = (avcC?.PPS ?? []).map((n) => n?.data).filter((d) => d instanceof Uint8Array);
  if (sps.length === 0 || pps.length === 0) return undefined;
  const parts = [
    1,
    avcC.AVCProfileIndication ?? 66,
    avcC.profile_compatibility ?? 0,
    avcC.AVCLevelIndication ?? 30,
    0xff,
    0xe0 | (sps.length & 0x1f),
  ];
  for (const s of sps) {
    parts.push((s.length >> 8) & 0xff, s.length & 0xff, ...s);
  }
  parts.push(pps.length & 0xff);
  for (const p of pps) {
    parts.push((p.length >> 8) & 0xff, p.length & 0xff, ...p);
  }
  return Uint8Array.from(parts);
}

await new Promise((resolve, reject) => {
  mp4.onError = (m, msg) => reject(new Error(`${m}: ${msg}`));
  mp4.onReady = (info) => {
    const v = info.videoTracks[0];
    if (!v) return reject(new Error('无视频轨道'));
    console.log('codec      :', v.codec);
    console.log('尺寸       :', v.track_width, 'x', v.track_height);
    console.log('时长       :', (v.duration / v.timescale).toFixed(2), 's');
    console.log('样本数     :', v.nb_samples);
    mp4.setExtractionOptions(v.id, {});
    mp4.start();
  };
  mp4.onSamples = (_id, _u, s) => samples.push(...s);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  ab.fileStart = 0;
  mp4.appendBuffer(ab);
  mp4.flush();
  setTimeout(() => {
    const trak = mp4.moov?.traks?.[0];
    const descBoxes = trak?.samples?.[0]?.description?.boxes;
    const avcC = descBoxes?.find((b) => b.type === 'avcC');
    const built = avcC ? buildAvcC(avcC) : undefined;
    console.log('avcC 重建  :', built ? `${built.length} bytes, 头字节 [${[...built.slice(0, 4)].join(',')}]` : '失败');
    console.log('提取样本数 :', samples.length);
    const first = samples[0];
    if (first) {
      console.log('首样本     : sync=%s size=%d dataLen=%d', first.is_sync, first.size, first.data?.length);
    }
    resolve(null);
  }, 200);
});
