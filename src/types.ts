/**
 * 全局类型定义。所有几何坐标一律使用归一化坐标（0~1，左上角原点），
 * 仅在最终导出 ASS 时换算为像素，保证同一套算法与视频分辨率无关。
 */

/** 轴对齐矩形（归一化坐标） */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 带置信度的人脸观测 */
export interface FaceObservation {
  rect: Rect;
  confidence: number;
}

/** 画面中已有文字（招牌、手机屏幕字幕等）的检测框 */
export interface TextBox {
  rect: Rect;
  /** 笔画/边缘密度，作为文字置信度 */
  score: number;
}

/** 单帧分析结果 */
export interface FrameAnalysis {
  /** 帧时间戳（秒） */
  time: number;
  /** 帧序号（解码序列） */
  index: number;
  faces: FaceObservation[];
  textBoxes: TextBox[];
  /** 原始亮度网格（帧间差分/镜头切换用），宽 saliencyW 高 saliencyH */
  luma: Float32Array;
  /** 边缘密度网格，尺寸同 luma */
  edge: Float32Array;
  /** 显著图：行优先、宽 w 高 h 的网格，值 0~1，表示观众视线概率 */
  saliency: Float32Array;
  saliencyW: number;
  saliencyH: number;
  /** 全帧平均亮度 0~1 */
  meanLuma: number;
  /** 全帧亮度标准差 */
  lumaStd: number;
}

/** 镜头（一个连续机位片段） */
export interface Shot {
  id: number;
  start: number;
  end: number;
  /** 该镜头覆盖的分析帧下标（在 FrameAnalysis 数组中的区间） */
  frameStart: number;
  frameEnd: number;
}

/** 字幕条目（句子级时间轴） */
export interface SubtitleCue {
  id: string;
  start: number;
  end: number;
  text: string;
  /** 跨镜头拆分时，指向原始字幕 id；未拆分为自身 id */
  originalId?: string;
}

/** 字幕条目的排版决策结果 */
export interface PlacedCue {
  cue: SubtitleCue;
  /** 字幕框（归一化），x 为左边 */
  box: Rect;
  /** 锚点水平位置 0~1（ASS \an 用） */
  anchorX: number;
  /** 锚点垂直位置 0~1 */
  anchorY: number;
  /** 是否加底（半透明底框） */
  background: boolean;
  /** 选择该位置的主要原因，用于前端调试展示 */
  reason: string;
  /** 与人脸/画面文字的重叠面积（归一化），正常应为 0 */
  overlapArea: number;
  /** 归属镜头 id */
  shotId: number;
  /** 对话模式下靠近的说话人序号（-1 表示无特定说话人） */
  speakerFace: number;
}

/** 排版运行参数 */
export interface LayoutOptions {
  /** 分析帧率（fps），默认 4 */
  analysisFps: number;
  /** 字幕区域距画面边缘的安全边距（归一化） */
  margin: number;
  /** 字幕最大宽度占比 */
  maxTextWidthRatio: number;
  /** 字幕行高占画面高度比例 */
  lineHeightRatio: number;
  /** 候选位置的纵向步长（归一化高度） */
  rowStep: number;
  /** 人脸框向外膨胀的安全余量（归一化） */
  facePadding: number;
  /** 文字框向外膨胀的安全余量（归一化） */
  textPadding: number;
  /** 镜头内位置跳变惩罚权重 */
  jumpWeight: number;
  /** 显著区域遮挡惩罚权重 */
  saliencyWeight: number;
  /** 偏离画面偏好位置的惩罚权重 */
  preferenceWeight: number;
  /** 触底加底的局部亮度阈值（高于此值判定为太亮） */
  brightLumaThreshold: number;
  /** 触底加底的局部纹理/复杂度阈值 */
  busyTextureThreshold: number;
  /** 对话模式：字幕向说话人一侧收缩的宽度比例 */
  dialogueWidthRatio: number;
  /** 镜头切换判定的帧间差分阈值 0~1 */
  shotChangeThreshold: number;
  /** 双说话人判定：人脸横向间距超过画面宽度的该比例才算左右分立 */
  speakerSeparation: number;
}

export const DEFAULT_LAYOUT_OPTIONS: LayoutOptions = {
  analysisFps: 4,
  margin: 0.04,
  maxTextWidthRatio: 0.86,
  lineHeightRatio: 0.115,
  rowStep: 0.025,
  facePadding: 0.012,
  textPadding: 0.008,
  jumpWeight: 0.55,
  saliencyWeight: 0.35,
  preferenceWeight: 0.22,
  brightLumaThreshold: 0.72,
  busyTextureThreshold: 0.16,
  dialogueWidthRatio: 0.62,
  shotChangeThreshold: 0.32,
  speakerSeparation: 0.28,
};

/** 处理进度消息 */
export interface ProgressMessage {
  phase: 'decode' | 'analyze' | 'segment' | 'layout' | 'done' | 'error';
  /** 0~1 */
  progress: number;
  message: string;
  detail?: Record<string, number | string | boolean>;
}

/** 一次完整排版的产物 */
export interface LayoutResult {
  width: number;
  height: number;
  duration: number;
  fps: number;
  options: LayoutOptions;
  shots: Shot[];
  frames: FrameAnalysis[];
  placed: PlacedCue[];
  /** 与人脸重叠的分析帧数量（目标为 0） */
  faceOverlapFrames: number;
  /** 与画面文字重叠的分析帧数量 */
  textOverlapFrames: number;
  /** 各阶段耗时（毫秒） */
  timings: Record<string, number>;
}
