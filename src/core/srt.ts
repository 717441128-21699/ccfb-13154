import type { SubtitleCue } from '../types';

/**
 * 解析 SRT 字幕（支持 UTF-8、CRLF/LF、序号可选）。
 * 时间轴格式：HH:MM:SS,mmm --> HH:MM:SS,mmm
 */
export function parseSrt(content: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const blocks = content.replace(/^﻿/, '').trim().split(/\r?\n\r?\n/);

  for (const block of blocks) {
    const lines = block.split(/\r?\n/).filter((l) => l.length > 0);
    if (lines.length === 0) continue;

    let timeLineIdx = 0;
    // 首行可能是序号
    if (lines.length >= 2 && /^\d+$/.test(lines[0]!.trim())) {
      timeLineIdx = 1;
    }
    const timeLine = lines[timeLineIdx];
    if (!timeLine) continue;

    const match = timeLine.match(
      /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/,
    );
    if (!match) continue;

    const start = toSeconds(match[1]!, match[2]!, match[3]!, match[4]!);
    const end = toSeconds(match[5]!, match[6]!, match[7]!, match[8]!);
    const text = lines
      .slice(timeLineIdx + 1)
      .join('\n')
      .replace(/<[^>]+>/g, '') // 去掉 SRT 内联标签
      .trim();
    if (!text) continue;

    cues.push({
      id: `cue-${cues.length + 1}`,
      start,
      end: Math.max(end, start + 0.001),
      text,
    });
  }

  cues.sort((a, b) => a.start - b.start);
  return cues;
}

function toSeconds(h: string, m: string, s: string, ms: string): number {
  return (
    Number(h) * 3600 +
    Number(m) * 60 +
    Number(s) +
    Number(ms.padEnd(3, '0')) / 1000
  );
}

/** 秒 -> ASS 时间戳 H:MM:SS.cc（厘秒） */
export function toAssTime(seconds: number): string {
  const v = Math.max(0, seconds);
  const h = Math.floor(v / 3600);
  const m = Math.floor((v % 3600) / 60);
  const s = Math.floor(v % 60);
  const cs = Math.round((v - Math.floor(v)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(
    cs,
  ).padStart(2, '0')}`;
}
