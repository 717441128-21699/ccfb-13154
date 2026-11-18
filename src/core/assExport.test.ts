import { describe, expect, it } from 'vitest';
import { exportAss } from './assExport';
import { DEFAULT_LAYOUT_OPTIONS, type PlacedCue } from '../types';

function makePlaced(over: Partial<PlacedCue>): PlacedCue {
  return {
    cue: { id: 'c1', start: 1, end: 3, text: '测试台词' },
    box: { x: 0.1, y: 0.75, w: 0.8, h: 0.1 },
    anchorX: 0.5,
    anchorY: 0.8,
    background: false,
    reason: '底部安全区',
    overlapArea: 0,
    shotId: 0,
    speakerFace: -1,
    ...over,
  };
}

describe('ASS 导出', () => {
  it('包含脚本头、样式表和带 \\pos 的 Dialogue 事件', () => {
    const ass = exportAss({
      width: 1080,
      height: 1920,
      options: DEFAULT_LAYOUT_OPTIONS,
      placed: [makePlaced({}), makePlaced({ background: true, cue: { id: 'c2', start: 4, end: 6, text: '加底台词' } })],
    });
    expect(ass).toContain('[Script Info]');
    expect(ass).toContain('PlayResX: 1080');
    expect(ass).toContain('PlayResY: 1920');
    expect(ass).toContain('[V4+ Styles]');
    expect(ass).toContain('Style: Default');
    expect(ass).toContain('Style: Boxed');
    expect(ass).toContain('[Events]');
    // 位置：anchorX=0.5*1080=540, anchorY=0.8*1920=1536
    expect(ass).toContain('\\an5\\pos(540,1536)');
    // 加底事件使用 Boxed 样式
    expect(ass).toMatch(/Dialogue: 0,0:00:04\.00,0:00:06\.00,Boxed/);
    // 换行转义
    expect(ass).toContain('Dialogue:');
  });

  it('时间戳和文本转义正确', () => {
    const ass = exportAss({
      width: 1080,
      height: 1920,
      options: DEFAULT_LAYOUT_OPTIONS,
      placed: [
        makePlaced({
          cue: { id: 'c3', start: 3661.5, end: 3663, text: '第一行\n第二行{带括号}' },
        }),
      ],
    });
    expect(ass).toContain('1:01:01.50');
    expect(ass).toContain('第一行\\N第二行(带括号)');
  });
});
