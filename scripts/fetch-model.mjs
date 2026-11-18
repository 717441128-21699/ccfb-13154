// 下载 MediaPipe FaceDetector 模型到 public/models，使应用完全离线可用。
// 失败时不阻断安装：应用在运行时会回退到 CDN 地址并给出明确提示。
import { mkdirSync, writeFile } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const destDir = resolve(here, '..', 'public', 'models');
const dest = resolve(destDir, 'blaze_face_short_range.tflite');
const urls = [
  'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite',
  'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
];

mkdirSync(destDir, { recursive: true });

for (const url of urls) {
  try {
    console.log(`[fetch-model] GET ${url}`);
    // redirect: 'manual' 可避免部分企业代理下 undici 跟随跳转异常
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000) throw new Error(`文件过小（${buf.length} 字节），疑似错误页`);
    writeFile(dest, buf);
    console.log(`[fetch-model] 已保存 ${dest}（${(buf.length / 1024).toFixed(1)} KB）`);
    process.exit(0);
  } catch (err) {
    console.warn(`[fetch-model] 失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}
console.warn('[fetch-model] 所有下载地址均失败，请稍后手动下载模型放到 public/models/');
process.exit(0);
