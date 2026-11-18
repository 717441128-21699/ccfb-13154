import type { LayoutOptions, PlacedCue } from '../types';
import { toAssTime } from './srt';

/** 导出 ASS 所需的最小结果结构（同时兼容完整 LayoutResult 与其可克隆子集） */
export interface AssExportSource {
  width: number;
  height: number;
  options: LayoutOptions;
  placed: PlacedCue[];
}

/**
 * 导出带位置信息的 ASS（Advanced SubStation Alpha v4.00+）。
 *
 * 位置：每条 Dialogue 携带 \an5 + \pos(x,y)，锚点为字幕框中心，
 * 分辨率与视频一致，播放器（FFmpeg/剪映/PotPlayer 等）可直接渲染。
 * 加底：不依赖 ASS 绘图，用主样式描边 + 事件级 \1a/背景色实现，
 * 兼容性最好；需要更强调时由样式 BorderStyle=3（不透明底框）承担。
 */
export function exportAss(result: AssExportSource): string {
  const { width, height, placed, options } = result;

  // 主字体大小：按行高占比换算，取偶数便于渲染
  const fontPx = Math.round(options.lineHeightRatio * height * 0.62);
  const outlinePx = Math.max(2, Math.round(fontPx * 0.12));
  const shadowPx = Math.max(1, Math.round(fontPx * 0.08));
  const marginV = Math.round(options.margin * height);
  const marginL = Math.round(options.margin * width);

  const lines: string[] = [];
  lines.push('[Script Info]');
  lines.push('; 由短剧字幕自动排版工具生成');
  lines.push('Title: Auto Layout Subtitles');
  lines.push('ScriptType: v4.00+');
  lines.push(`PlayResX: ${width}`);
  lines.push(`PlayResY: ${height}`);
  lines.push('WrapStyle: 0');
  lines.push('ScaledBorderAndShadow: yes');
  lines.push('YCbCr Matrix: TV.709');
  lines.push('');

  lines.push('[V4+ Styles]');
  lines.push(
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  );
  // BorderStyle=1 描边+阴影（默认）；加底事件额外叠加底色块
  lines.push(
    'Style: ' +
      assStyle(
        'Default',
        fontPx,
        '&H00FFFFFF',
        '&H000000FF',
        '&H00101010',
        '&H64000000',
        1,
        outlinePx,
        shadowPx,
        marginL,
        marginV,
      ),
  );
  // 不透明底框样式，供“太亮/太花”事件使用
  lines.push(
    'Style: ' +
      assStyle(
        'Boxed',
        fontPx,
        '&H00FFFFFF',
        '&H000000FF',
        '&H00202020',
        '&HC8000000',
        3,
        outlinePx,
        0,
        marginL,
        marginV,
      ),
  );
  lines.push('');

  lines.push('[Events]');
  lines.push(
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  );

  for (const p of placed) {
    const x = Math.round(p.anchorX * width);
    const y = Math.round(p.anchorY * height);
    const style = p.background ? 'Boxed' : 'Default';
    const text = escapeAssText(p.cue.text);
    // \an5 中中对齐，\pos 精确定位；加底事件补一层半透明背景矩形色
    const override = p.background
      ? `{\\an5\\pos(${x},${y})\\bord${outlinePx}\\3c&H202020&\\1a&H00&}`
      : `{\\an5\\pos(${x},${y})}`;
    lines.push(
      `Dialogue: 0,${toAssTime(p.cue.start)},${toAssTime(p.cue.end)},${style},,0,0,0,,${override}${text}`,
    );
  }

  return lines.join('\r\n') + '\r\n';
}

function assStyle(
  name: string,
  fontPx: number,
  primary: string,
  secondary: string,
  outline: string,
  back: string,
  borderStyle: number,
  outlineW: number,
  shadow: number,
  marginL: number,
  marginV: number,
): string {
  return [
    name,
    'Microsoft YaHei',
    fontPx,
    primary,
    secondary,
    outline,
    back,
    -1, // Bold
    0,
    0,
    0,
    100,
    100,
    0,
    0,
    borderStyle,
    outlineW,
    shadow,
    5, // Alignment（默认中下，事件级 \an 会覆盖）
    marginL,
    marginL,
    marginV,
    1, // GB2312/UTF-8 播放端一般按 BOM 处理
  ].join(', ');
}

function escapeAssText(text: string): string {
  return text
    .replace(/\r?\n/g, '\\N')
    .replace(/\{/g, '(')
    .replace(/\}/g, ')');
}

/** 生成带 UTF-8 BOM 的 ASS 文件 Blob（Windows 播放器兼容） */
export function buildAssBlob(result: AssExportSource): Blob {
  const content = exportAss(result);
  return new Blob(['﻿', content], { type: 'text/plain;charset=utf-8' });
}

/** 触发浏览器下载 */
export function downloadAss(result: AssExportSource, filename: string): void {
  const url = URL.createObjectURL(buildAssBlob(result));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.ass') ? filename : `${filename}.ass`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 排版结果的 JSON 快照（含全部位置/障碍/镜头信息，供复核与二次编辑） */
export function exportResultJson(result: AssExportSource & Record<string, unknown>): string {
  return JSON.stringify(
    {
      width: result.width,
      height: result.height,
      faceOverlapFrames:
        'faceOverlapFrames' in result ? result.faceOverlapFrames : undefined,
      textOverlapFrames:
        'textOverlapFrames' in result ? result.textOverlapFrames : undefined,
      timings: 'timings' in result ? result.timings : undefined,
      shots: 'shots' in result ? result.shots : undefined,
      placed: result.placed.map((p: PlacedCue) => ({
        start: p.cue.start,
        end: p.cue.end,
        text: p.cue.text,
        box: p.box,
        anchorX: p.anchorX,
        anchorY: p.anchorY,
        background: p.background,
        reason: p.reason,
        overlapArea: p.overlapArea,
        shotId: p.shotId,
        speakerFace: p.speakerFace,
      })),
    },
    null,
    2,
  );
}
