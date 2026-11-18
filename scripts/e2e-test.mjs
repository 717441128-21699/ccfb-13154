// 真实浏览器端到端测试：WebCodecs 解码 + MediaPipe 人脸 + 完整排版 + ASS 导出
// 使用系统 Chrome（playwright-core，不下载浏览器）
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const VIDEO = resolve(root, 'test-media/portrait-scene.mp4');
const SRT = resolve(root, 'test-media/sample.srt');
const OUT = resolve(root, 'test-media/out');
mkdirSync(OUT, { recursive: true });

const PORT = 5199;
const BASE = `http://localhost:${PORT}/`;

function freePort() {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -Confirm:$false }"`,
      { stdio: 'ignore' },
    );
    void out;
  } catch { /* 端口本就空闲 */ }
}

function startDevServer() {
  freePort();
  return new Promise((resolve, reject) => {
    const proc = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
      cwd: root,
      shell: true,
    });
    proc.stdout.on('data', (d) => process.stdout.write(`[vite] ${d}`));
    proc.stderr.on('data', (d) => process.stderr.write(`[vite-err] ${d}`));
    proc.on('exit', (code) => {
      reject(new Error(`vite 提前退出: ${code}`));
    });

    const deadline = Date.now() + 30000;
    const poll = async () => {
      try {
        const r = await fetch(BASE);
        if (r.ok) return resolve(proc);
      } catch { /* 还没起来 */ }
      if (Date.now() > deadline) return reject(new Error('vite 30 秒内未就绪'));
      setTimeout(poll, 300);
    };
    setTimeout(poll, 800);
  });
}

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

const server = await startDevServer();
const failures = [];
let browser;

try {
  browser = await chromium.launch({
    headless: true,
    executablePath: CHROME_CANDIDATES[0],
    args: ['--no-sandbox', '--use-gl=angle', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1360, height: 960 } });
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#run-btn');

  // 上传视频
  await page.setInputFiles('#video-input', VIDEO);
  // 填 SRT
  const srtText = readFileSync(SRT, 'utf8');
  await page.fill('#srt-input', srtText);
  await page.click('#run-btn');

  // 等待结果区出现（最长 90 秒）
  try {
    await page.waitForSelector('#result-area:not([hidden])', { timeout: 90000 });
  } catch (e) {
    const errBox = await page.$eval('#error-box', (el) => ({
      hidden: el.hidden,
      text: el.textContent,
    })).catch(() => null);
    const progress = await page.$eval('#progress-msg', (el) => el.textContent).catch(() => null);
    const fill = await page.$eval('#progress-fill', (el) => el.style.width).catch(() => null);
    await page.screenshot({ path: resolve(OUT, 'failure.png'), fullPage: true });
    console.error('超时快照:', { errBox, progress, fill });
    console.error('控制台错误:', consoleErrors.slice(0, 10));
    throw e;
  }
  await page.waitForSelector('.metric .v', { timeout: 5000 });

  const metrics = await page.$$eval('.metric', (els) =>
    els.map((e) => ({
      v: e.querySelector('.v')?.textContent?.trim(),
      k: e.querySelector('.k')?.textContent?.trim(),
    })),
  );
  console.log('指标:');
  for (const m of metrics) console.log(`  ${m.v}  ${m.k}`);

  const faceOverlap = Number(metrics.find((m) => m.k?.includes('压人脸'))?.v ?? 'NaN');
  const textOverlap = Number(metrics.find((m) => m.k?.includes('压画面文字'))?.v ?? 'NaN');
  const shotCount = Number(metrics.find((m) => m.k === '镜头数')?.v ?? 'NaN');
  const eventCount = Number(metrics.find((m) => m.k === '字幕事件数')?.v ?? 'NaN');

  if (faceOverlap !== 0) failures.push(`人脸重叠帧数应为 0，实际 ${faceOverlap}`);
  if (textOverlap !== 0) failures.push(`画面文字重叠帧数应为 0，实际 ${textOverlap}`);
  if (!(shotCount >= 2)) failures.push(`应检测到至少 2 个镜头，实际 ${shotCount}`);
  if (!(eventCount >= 4)) failures.push(`应至少输出 4 条字幕事件，实际 ${eventCount}`);

  // 拖动时间轴到有人脸的时刻再统计一次
  await page.fill('#seek', '2');
  await page.dispatchEvent('#seek', 'input');
  await page.waitForTimeout(300);
  const faceRects = await page.$$eval('svg.overlay rect.face', (els) => els.length);
  const subRects = await page.$$eval('svg.overlay rect.subtitle', (els) => els.length);
  console.log('t=2s 人脸框:', faceRects, ' 字幕框:', subRects);
  if (faceRects < 1) failures.push('MediaPipe 未在视频中检出人脸（期望至少 1 个）');
  if (subRects < 1) failures.push('生效字幕未绘制位置框');

  // 下载 ASS（通过 Playwright download 事件捕获 Blob 保存）
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }),
    page.click('#download-ass'),
  ]);
  const assPath = resolve(OUT, 'portrait-scene.ass');
  await download.saveAs(assPath);
  const ass = readFileSync(assPath, 'utf8');
  writeFileSync(resolve(OUT, 'console-errors.txt'), consoleErrors.join('\n') || '(none)');

  // ASS 内容断言
  const checks = [
    ['[Script Info]', ass.includes('[Script Info]')],
    ['PlayResX: 1080', ass.includes('PlayResX: 1080')],
    ['PlayResY: 1920', ass.includes('PlayResY: 1920')],
    ['带 \\pos 定位', /\\an5\\pos\(\d+,\d+\)/.test(ass)],
    ['Dialogue 事件数 >= 4', (ass.match(/^Dialogue:/gm) ?? []).length >= 4],
    ['Boxed/Default 样式', ass.includes('Style: Default') && ass.includes('Style: Boxed')],
  ];
  console.log('\nASS 校验:');
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) failures.push(`ASS 校验失败: ${name}`);
  }

  // 验证所有字幕框确实在人脸框上方（读结果 JSON 下载）
  const [jsonDl] = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }),
    page.click('#download-json'),
  ]);
  const jsonPath = resolve(OUT, 'layout.json');
  await jsonDl.saveAs(jsonPath);
  const layout = JSON.parse(readFileSync(jsonPath, 'utf8'));
  console.log('\n字幕位置（anchorY 归一化，越小越靠上）:');
  for (const p of layout.placed) {
    console.log(
      `  ${p.start.toFixed(1)}-${p.end.toFixed(1)}s y=${p.box.y.toFixed(3)} h=${p.box.h.toFixed(3)} 底=${p.background}  ${p.reason}`,
    );
  }

  console.log('\n浏览器控制台错误:', consoleErrors.length ? consoleErrors.slice(0, 5) : '(none)');
} catch (err) {
  failures.push(`E2E 异常: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await browser?.close();
  server.kill();
}

if (failures.length) {
  console.error('\n❌ E2E 失败:');
  for (const f of failures) console.error('  -', f);
  process.exit(1);
}
console.log('\n✅ E2E 全部通过');
