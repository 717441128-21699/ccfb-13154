import { DEFAULT_LAYOUT_OPTIONS, type LayoutOptions, type SubtitleCue } from '../types';
import { LayoutEngine } from '../engine';
import { parseSrt } from '../core/srt';
import { downloadAss, exportResultJson } from '../core/assExport';
import type { PreviewFrame, TransferableLayoutResult, WorkerProgress } from '../workerProtocol';
import { OverlayRenderer } from './overlay';

const SAMPLE_SRT = `1
00:00:01,000 --> 00:00:03,500
你到底想干什么？

2
00:00:03,800 --> 00:00:06,200
我只是想把事情说清楚。

3
00:00:06,500 --> 00:00:09,000
现在说这些还有意义吗？
`;

export class App {
  private el: HTMLElement;
  private engine = new LayoutEngine();
  private videoFile: File | null = null;
  private videoUrl: string | null = null;
  private result: TransferableLayoutResult | null = null;
  private previewFrames: PreviewFrame[] = [];
  private overlay: OverlayRenderer | null = null;
  private rafId = 0;

  constructor(el: HTMLElement) {
    this.el = el;
    this.render();
  }

  private render(): void {
    this.el.innerHTML = `
      <header>
        <h1>短剧字幕自动排版</h1>
        <p>浏览器本地解码 · 自动避人脸 / 画面文字 / 视觉焦点 · 导出带位置的 ASS 字幕</p>
      </header>
      <div class="layout">
        <div class="panel" id="control-panel">${this.controlsHtml()}</div>
        <div class="panel" id="result-panel">
          <h2>预览与结果</h2>
          <div id="empty-hint" class="hint">上传竖屏短剧视频（MP4，H.264/H.265）和 SRT 字幕后开始排版。<br>
          全程在本机浏览器内运行，视频不会上传到任何服务器。</div>
          <div id="result-area" hidden></div>
        </div>
      </div>`;
    this.bindControls();
  }

  private controlsHtml(): string {
    const o = DEFAULT_LAYOUT_OPTIONS;
    return `
      <h2>输入与参数</h2>
      <div class="field">
        <label>视频文件（竖屏 MP4）</label>
        <div class="dropzone" id="dropzone"><strong>点击选择</strong> 或拖拽视频到此处</div>
        <input type="file" id="video-input" accept="video/mp4,video/quicktime,video/webm">
        <div class="hint" id="video-name"></div>
      </div>
      <div class="field">
        <label>SRT 字幕</label>
        <textarea id="srt-input" placeholder="粘贴 SRT 内容，或载入 .srt 文件"></textarea>
        <input type="file" id="srt-file" accept=".srt,.txt" hidden>
        <div class="actions">
          <button class="secondary" id="load-srt-btn" type="button">载入 SRT 文件</button>
          <button class="secondary" id="sample-srt-btn" type="button">填入示例</button>
        </div>
      </div>
      <div class="field">
        <label>排版参数</label>
        <div class="row">
          <div>
            <label>分析帧率 (fps)</label>
            <input type="number" id="opt-fps" value="${o.analysisFps}" min="1" max="12" step="1">
          </div>
          <div>
            <label>镜头切换阈值</label>
            <input type="number" id="opt-shot" value="${o.shotChangeThreshold}" min="0.1" max="0.9" step="0.02">
          </div>
        </div>
        <div class="row" style="margin-top:8px">
          <div>
            <label>亮底阈值</label>
            <input type="number" id="opt-bright" value="${o.brightLumaThreshold}" min="0.3" max="0.95" step="0.02">
          </div>
          <div>
            <label>跳变惩罚权重</label>
            <input type="number" id="opt-jump" value="${o.jumpWeight}" min="0" max="2" step="0.05">
          </div>
        </div>
      </div>
      <button id="run-btn" disabled>开始自动排版</button>
      <div class="progress-wrap" id="progress-wrap" hidden>
        <div class="progress-bar"><div id="progress-fill"></div></div>
        <div class="progress-msg" id="progress-msg"></div>
      </div>
      <div id="error-box" class="error-box" hidden></div>`;
  }

  private bindControls(): void {
    const dz = this.el.querySelector('#dropzone') as HTMLElement;
    const videoInput = this.el.querySelector('#video-input') as HTMLInputElement;
    dz.addEventListener('click', () => videoInput.click());
    dz.addEventListener('dragover', (e) => {
      e.preventDefault();
      dz.classList.add('drag');
    });
    dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
    dz.addEventListener('drop', (e) => {
      e.preventDefault();
      dz.classList.remove('drag');
      const f = e.dataTransfer?.files?.[0];
      if (f) this.setVideo(f);
    });
    videoInput.addEventListener('change', () => {
      const f = videoInput.files?.[0];
      if (f) this.setVideo(f);
    });

    const srtFile = this.el.querySelector('#srt-file') as HTMLInputElement;
    this.el.querySelector('#load-srt-btn')!.addEventListener('click', () => srtFile.click());
    srtFile.addEventListener('change', async () => {
      const f = srtFile.files?.[0];
      if (!f) return;
      (this.el.querySelector('#srt-input') as HTMLTextAreaElement).value = await f.text();
    });
    this.el.querySelector('#sample-srt-btn')!.addEventListener('click', () => {
      (this.el.querySelector('#srt-input') as HTMLTextAreaElement).value = SAMPLE_SRT;
    });

    this.el.querySelector('#run-btn')!.addEventListener('click', () => this.run());
  }

  private setVideo(file: File): void {
    this.videoFile = file;
    if (this.videoUrl) URL.revokeObjectURL(this.videoUrl);
    this.videoUrl = URL.createObjectURL(file);
    (this.el.querySelector('#video-name') as HTMLElement).textContent =
      `已选择：${file.name}（${(file.size / 1024 / 1024).toFixed(1)} MB）`;
    (this.el.querySelector('#run-btn') as HTMLButtonElement).disabled = false;
  }

  private collectOptions(): LayoutOptions {
    const opts = { ...DEFAULT_LAYOUT_OPTIONS };
    const assign = (id: string, key: keyof LayoutOptions) => {
      const v = Number((this.el.querySelector(id) as HTMLInputElement).value);
      if (Number.isFinite(v)) (opts as Record<string, number>)[key] = v;
    };
    assign('#opt-fps', 'analysisFps');
    assign('#opt-shot', 'shotChangeThreshold');
    assign('#opt-bright', 'brightLumaThreshold');
    assign('#opt-jump', 'jumpWeight');
    return opts;
  }

  private run(): void {
    if (!this.videoFile) return;
    const srtText = (this.el.querySelector('#srt-input') as HTMLTextAreaElement).value.trim();
    let cues: SubtitleCue[] = [];
    if (srtText) {
      cues = parseSrt(srtText);
      if (cues.length === 0) {
        this.showError('SRT 解析失败：未识别到有效时间轴条目');
        return;
      }
    } else {
      this.showError('请先粘贴或载入 SRT 字幕');
      return;
    }

    this.hideError();
    const btn = this.el.querySelector('#run-btn') as HTMLButtonElement;
    btn.disabled = true;
    const wrap = this.el.querySelector('#progress-wrap') as HTMLElement;
    wrap.hidden = false;

    this.engine.start(this.videoFile, cues, this.collectOptions(), {
      onProgress: (p: WorkerProgress) => this.updateProgress(p),
      onFramePreview: (frames) => {
        this.previewFrames = frames;
      },
      onDone: (result) => {
        this.result = result;
        btn.disabled = false;
        this.renderResult();
      },
      onError: (msg) => {
        btn.disabled = false;
        this.showError(msg);
      },
    });
  }

  private updateProgress(p: WorkerProgress): void {
    (this.el.querySelector('#progress-fill') as HTMLElement).style.width =
      `${Math.round(p.progress * 100)}%`;
    (this.el.querySelector('#progress-msg') as HTMLElement).textContent = p.message;
  }

  private showError(msg: string): void {
    const box = this.el.querySelector('#error-box') as HTMLElement;
    box.hidden = false;
    box.textContent = msg;
  }

  private hideError(): void {
    (this.el.querySelector('#error-box') as HTMLElement).hidden = true;
  }

  private renderResult(): void {
    if (!this.result) return;
    const r = this.result;
    (this.el.querySelector('#empty-hint') as HTMLElement).hidden = true;
    const area = this.el.querySelector('#result-area') as HTMLElement;
    area.hidden = false;

    const faceOk = r.faceOverlapFrames === 0;
    area.innerHTML = `
      <div class="metrics">
        <div class="metric ${faceOk ? 'ok' : 'bad'}">
          <div class="v">${r.faceOverlapFrames}</div>
          <div class="k">字幕压人脸的分析帧数（目标 0）</div>
        </div>
        <div class="metric ${r.textOverlapFrames === 0 ? 'ok' : 'bad'}">
          <div class="v">${r.textOverlapFrames}</div>
          <div class="k">压画面文字的分析帧数</div>
        </div>
        <div class="metric"><div class="v">${r.shots.length}</div><div class="k">镜头数</div></div>
        <div class="metric"><div class="v">${r.placed.length}</div><div class="k">字幕事件数</div></div>
        <div class="metric"><div class="v">${(r.timings.decode ?? 0).toFixed(0)} ms</div><div class="k">解码分析耗时</div></div>
        <div class="metric"><div class="v">${(r.timings.layout ?? 0).toFixed(0)} ms</div><div class="k">排版求解耗时</div></div>
      </div>
      <div class="preview-stage">
        <div>
          <div class="phone" id="phone">
            <video id="preview-video" src="${this.videoUrl ?? ''}" muted playsinline></video>
          </div>
          <div class="timeline-controls">
            <button class="secondary" id="play-btn" type="button" style="width:auto;padding:8px 14px">播放</button>
            <input type="range" id="seek" min="0" max="${r.duration}" step="0.05" value="0">
          </div>
        </div>
        <div class="legend">
          <span><i style="background:rgba(79,140,255,.4);border:1px solid var(--face)"></i>人脸检测框</span>
          <span><i style="background:rgba(251,189,35,.3);border:1px dashed var(--text-box)"></i>画面文字（招牌/手机屏）</span>
          <span><i style="background:rgba(54,211,153,.3);border:1px solid var(--subtitle)"></i>字幕位置</span>
          <span><i style="background:rgba(248,114,114,.35);border:1px solid var(--danger)"></i>加底字幕（背景太亮/太花）</span>
        </div>
      </div>
      <div class="actions">
        <button class="success" id="download-ass" type="button">下载 ASS 字幕</button>
        <button class="secondary" id="download-json" type="button">下载排版数据 JSON</button>
      </div>
      <div style="max-height:260px;overflow:auto;margin-top:8px">
        <table class="cue-table">
          <thead><tr><th>时间</th><th>台词</th><th>位置</th><th>说明</th></tr></thead>
          <tbody>
            ${r.placed
              .map(
                (p, i) => `<tr data-idx="${i}">
                  <td>${p.cue.start.toFixed(2)}–${p.cue.end.toFixed(2)}</td>
                  <td>${escapeHtml(p.cue.text.replace(/\n/g, ' '))}</td>
                  <td>${p.background ? '<span class="badge boxed">加底</span>' : '<span class="badge">常规</span>'}</td>
                  <td>${escapeHtml(p.reason)}</td>
                </tr>`,
              )
              .join('')}
          </tbody>
        </table>
      </div>`;

    const phone = this.el.querySelector('#phone') as HTMLElement;
    this.overlay = new OverlayRenderer(phone);
    this.bindPreview(r);

    this.el.querySelector('#download-ass')!.addEventListener('click', () => {
      const name = this.videoFile?.name.replace(/\.[^.]+$/, '') ?? 'subtitle';
      downloadAss(r, `${name}.ass`);
    });
    this.el.querySelector('#download-json')!.addEventListener('click', () => {
      const blob = new Blob([exportResultJson(r)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${this.videoFile?.name.replace(/\.[^.]+$/, '') ?? 'subtitle'}-layout.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  private bindPreview(r: TransferableLayoutResult): void {
    const video = this.el.querySelector('#preview-video') as HTMLVideoElement;
    const seek = this.el.querySelector('#seek') as HTMLInputElement;
    const playBtn = this.el.querySelector('#play-btn') as HTMLButtonElement;

    const tick = () => {
      seek.value = String(video.currentTime);
      this.overlay?.render(video.currentTime, this.previewFrames, r.placed, r.shots);
      this.rafId = requestAnimationFrame(tick);
    };
    video.addEventListener('play', () => {
      playBtn.textContent = '暂停';
      cancelAnimationFrame(this.rafId);
      tick();
    });
    video.addEventListener('pause', () => {
      playBtn.textContent = '播放';
      cancelAnimationFrame(this.rafId);
    });
    playBtn.addEventListener('click', () => {
      if (video.paused) void video.play();
      else video.pause();
    });
    seek.addEventListener('input', () => {
      video.currentTime = Number(seek.value);
      this.overlay?.render(video.currentTime, this.previewFrames, r.placed, r.shots);
    });
    // 初始画一帧
    video.addEventListener(
      'loadeddata',
      () => this.overlay?.render(0, this.previewFrames, r.placed, r.shots),
      { once: true },
    );
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
