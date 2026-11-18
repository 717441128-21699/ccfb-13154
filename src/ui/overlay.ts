import type { PlacedCue } from '../types';
import type { PreviewFrame } from '../workerProtocol';

/**
 * SVG 叠加层：随视频播放时间绘制当前帧的人脸框、画面文字框、
 * 字幕位置框以及镜头切点横线。坐标全部使用归一化百分比。
 */
export class OverlayRenderer {
  private svg: SVGSVGElement;

  constructor(container: HTMLElement) {
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('class', 'overlay');
    this.svg.setAttribute('viewBox', '0 0 100 100');
    this.svg.setAttribute('preserveAspectRatio', 'none');
    container.appendChild(this.svg);
  }

  render(
    time: number,
    frames: PreviewFrame[],
    placed: PlacedCue[],
    shots: { id: number; start: number; end: number }[],
  ): void {
    while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);

    const frame = nearestFrame(frames, time);
    if (frame) {
      for (const face of frame.faces) {
        this.rect(face.rect.x * 100, face.rect.y * 100, face.rect.w * 100, face.rect.h * 100, 'face');
      }
      for (const tb of frame.textBoxes) {
        this.rect(tb.rect.x * 100, tb.rect.y * 100, tb.rect.w * 100, tb.rect.h * 100, 'textbox');
      }
    }

    // 当前时间生效的字幕框
    for (const p of placed) {
      if (time >= p.cue.start && time <= p.cue.end) {
        this.rect(
          p.box.x * 100,
          p.box.y * 100,
          p.box.w * 100,
          p.box.h * 100,
          p.background ? 'subtitle boxed' : 'subtitle',
        );
      }
    }

    // 镜头切点（在时间轴上最近的切点画横线提示）
    const shot = shots.find((s) => time >= s.start && time <= s.end);
    if (shot) {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', '0');
      line.setAttribute('x2', '100');
      line.setAttribute('y1', '2');
      line.setAttribute('y2', '2');
      line.setAttribute('class', 'shot');
      this.svg.appendChild(line);
    }
  }

  private rect(x: number, y: number, w: number, h: number, cls: string): void {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    el.setAttribute('x', String(x));
    el.setAttribute('y', String(y));
    el.setAttribute('width', String(w));
    el.setAttribute('height', String(h));
    el.setAttribute('rx', '1.2');
    el.setAttribute('class', cls);
    this.svg.appendChild(el);
  }

  clear(): void {
    while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);
  }
}

function nearestFrame(frames: PreviewFrame[], time: number): PreviewFrame | undefined {
  if (frames.length === 0) return undefined;
  let best = frames[0]!;
  let bestD = Infinity;
  for (const f of frames) {
    const d = Math.abs(f.time - time);
    if (d < bestD) {
      bestD = d;
      best = f;
    }
  }
  return best;
}
