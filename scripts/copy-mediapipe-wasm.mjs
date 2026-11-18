// 将 MediaPipe tasks-vision 的 WASM 运行时复制到 public 目录，
// 使 FaceDetector 可以通过固定 URL 离线加载，不依赖 CDN。
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const src = resolve(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const dest = resolve(root, 'public/mediapipe');

if (!existsSync(src)) {
  console.warn(`[copy-mediapipe-wasm] 源目录不存在，跳过: ${src}`);
} else {
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
  console.log(`[copy-mediapipe-wasm] 已复制 WASM 运行时 -> ${dest}`);
}
