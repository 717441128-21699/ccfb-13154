import type { LayoutOptions, Rect, SubtitleCue } from '../../types';
import { clamp } from '../geometry';

/**
 * 估算字幕文本渲染后的盒尺寸（归一化）。
 * 竖屏短剧字幕通常 12~16 个汉字一行；这里按字符数折行，
 * 与 ASS 导出的 WrapStyle=0（智能折行）配合，字体尺寸在导出时按分辨率标定。
 */
export function estimateCueBox(
  cue: SubtitleCue,
  opts: LayoutOptions,
  narrowForSpeaker = false,
): Rect {
  const maxCharsPerLine = narrowForSpeaker ? 9 : 15;
  const explicitLines = cue.text.split('\n');
  let lines = 0;
  let maxLineLen = 0;
  for (const raw of explicitLines) {
    const len = [...raw].length;
    maxLineLen = Math.max(maxLineLen, len);
    lines += Math.max(1, Math.ceil(len / maxCharsPerLine));
  }

  // 汉字近似正方形：行高即单字宽，宽度按最长行字符数估算
  const charW = opts.lineHeightRatio * 0.82;
  const widthCap = narrowForSpeaker
    ? opts.maxTextWidthRatio * opts.dialogueWidthRatio
    : opts.maxTextWidthRatio;
  const minWidth = narrowForSpeaker
    ? opts.lineHeightRatio * 1.4
    : opts.lineHeightRatio * 2.2;
  const w = clamp(
    Math.min(maxLineLen, maxCharsPerLine) * charW + opts.lineHeightRatio * 0.4,
    minWidth,
    widthCap,
  );
  const h = clamp(
    lines * opts.lineHeightRatio + opts.lineHeightRatio * 0.35,
    opts.lineHeightRatio * 1.3,
    opts.lineHeightRatio * 4.2,
  );
  // 初始位置无意义，候选生成时再定位
  return { x: 0, y: 0, w, h };
}

/** 一个可放置的候选位置 */
export interface Candidate {
  box: Rect;
  /** 锚点（ASS 对齐点）归一化坐标 */
  anchorX: number;
  anchorY: number;
  /** 候选所属纵向档位索引（用于跳变代价的归一化） */
  rowIndex: number;
  colIndex: number;
  /** 绑定的说话人人脸序号，-1 表示通用候选 */
  speaker: number;
}

/**
 * 生成候选位置网格：
 * - 纵向按 rowStep 铺满安全区；
 * - 横向分 左/中/右 三档（对话窄盒额外生成贴近说话人的档位）；
 * - 全部夹紧在安全边距内。
 */
export function generateCandidates(
  box0: Rect,
  opts: LayoutOptions,
  speakerRects: Rect[] = [],
): Candidate[] {
  const m = opts.margin;
  const minX = m;
  const maxX = 1 - m - box0.w;
  const minY = m;
  const maxY = 1 - m - box0.h;

  const cols: { x: number; colIndex: number; speaker: number }[] = [];

  if (speakerRects.length > 0) {
    // 对话模式：每个说话人生成贴近其一侧的候选，外加居中兜底
    speakerRects.forEach((face, idx) => {
      const faceCx = face.x + face.w / 2;
      const x = clamp(faceCx - box0.w / 2, minX, maxX);
      cols.push({ x, colIndex: idx, speaker: idx });
    });
    cols.push({
      x: clamp(0.5 - box0.w / 2, minX, maxX),
      colIndex: speakerRects.length,
      speaker: -1,
    });
  } else {
    const third = (maxX - minX) / 2;
    cols.push({ x: minX, colIndex: 0, speaker: -1 });
    cols.push({ x: clamp(0.5 - box0.w / 2, minX, maxX), colIndex: 1, speaker: -1 });
    if (third > 0.001) cols.push({ x: maxX, colIndex: 2, speaker: -1 });
  }

  const rows: { y: number; rowIndex: number }[] = [];
  for (let y = minY, idx = 0; y <= maxY + 1e-9; y += opts.rowStep, idx++) {
    rows.push({ y: clamp(y, minY, maxY), rowIndex: idx });
  }
  if (rows.length === 0) {
    rows.push({ y: minY, rowIndex: 0 });
  }

  const out: Candidate[] = [];
  for (const col of cols) {
    for (const row of rows) {
      out.push({
        box: { x: col.x, y: row.y, w: box0.w, h: box0.h },
        anchorX: col.x + box0.w / 2,
        anchorY: row.y + box0.h / 2,
        rowIndex: row.rowIndex,
        colIndex: col.colIndex,
        speaker: col.speaker,
      });
    }
  }
  return out;
}
