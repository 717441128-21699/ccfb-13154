import { describe, expect, it } from 'vitest';
import { parseSrt, toAssTime } from './srt';

describe('SRT 解析', () => {
  it('解析标准双条字幕', () => {
    const srt = `1
00:00:01,000 --> 00:00:03,500
你好世界

2
00:00:04,000 --> 00:00:06,250
第二句台词
第二行`;
    const cues = parseSrt(srt);
    expect(cues).toHaveLength(2);
    expect(cues[0]!.start).toBe(1);
    expect(cues[0]!.end).toBe(3.5);
    expect(cues[0]!.text).toBe('你好世界');
    expect(cues[1]!.text).toBe('第二句台词\n第二行');
  });

  it('兼容 CRLF、点号毫秒分隔与无序号块', () => {
    const srt = '00:00:01.500 --> 00:00:02.000\r\n只有一行';
    const cues = parseSrt(srt);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.start).toBe(1.5);
  });

  it('剥离内联 HTML 标签', () => {
    const cues = parseSrt(`1
00:00:01,000 --> 00:00:02,000
<b>加粗</b> 和 <i>斜体</i>`);
    expect(cues[0]!.text).toBe('加粗 和 斜体');
  });

  it('ASS 时间戳格式（厘秒、补零）', () => {
    expect(toAssTime(0)).toBe('0:00:00.00');
    expect(toAssTime(3661.5)).toBe('1:01:01.50');
  });
});
