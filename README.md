# 短剧字幕自动排版工具

竖屏短剧字幕自动避让排版：浏览器本地解码视频、检测人脸与画面文字、按句子时间轴自动选位，
导出带精确位置信息的 ASS 字幕。**全程在本机浏览器运行，视频不上传任何服务器。**

## 解决的问题

短剧剪辑中字幕常常压在演员脸上、盖住手机屏幕或招牌文字，传统方式需要逐条手动拖动。
本工具将一条 2 分钟成片的字幕排版压缩到数秒，并以「字幕与人脸重叠帧数 = 0」为硬约束。

## 能力对照

| 需求 | 实现 |
| --- | --- |
| 按镜头切开 | 帧间亮度差分 + 人脸突变辅助的镜头分割 |
| 每帧找人脸 | MediaPipe BlazeFace（WASM/本地模型，离线可用） |
| 找画面已有文字 | 低分辨率网格上的边缘密度 + 形态学连通域启发式检测 |
| 观众最可能看的区域 | 中心先验 + 边缘 + 人脸/文字加权的显著图 |
| 字幕自动躲开这些区域 | 候选位置评分 + 镜头内动态规划（碰撞为硬约束） |
| 同镜头位置不跳 | DP 跳变代价惩罚，同镜头纵向档位保持稳定 |
| 双人对话靠说话人 | 人脸聚类 + 嘴部运动启发式，字幕窄盒侧贴说话人 |
| 太亮/太花自动加底 | 字幕区局部亮度与纹理投票，触发不透明底框样式 |
| 2 分钟 5 分钟内排完 | 实测 12s 成片解码分析约 2.5s（4fps 抽帧、硬解） |
| 人脸重叠帧数为零 | 硬约束 + 区间障碍聚合，验收指标直接展示 |
| 导出带位置的 ASS | `\an5\pos(x,y)` 定位 + Default/Boxed 双样式 |
| 前端 TS、浏览器解码 | Vite + TypeScript，mp4box 解封装 + WebCodecs 硬解 |

## 快速开始

```bash
npm install        # 安装并自动复制 MediaPipe WASM 到 public/
npm run dev        # 启动开发服务器
# 浏览器打开终端给出的地址
```

1. 选择竖屏 MP4（H.264/H.265，建议 1080×1920）；
2. 粘贴 SRT 或载入 `.srt` 文件；
3. 调整分析帧率 / 镜头阈值 / 加底阈值等参数（可选）；
4. 点击「开始自动排版」，等待进度完成；
5. 在右侧预览叠加层核对人脸框、文字框、字幕位置；
6. 下载 `ASS`（导入剪映/FFmpeg/PotPlayer 等）或排版数据 `JSON`。

## 命令

```bash
npm run dev        # 开发
npm run build      # 类型检查 + 生产构建
npm run test       # 单元测试（Vitest）
npm run e2e        # 真实浏览器端到端测试（Playwright + 系统 Chrome）
```

## 架构

```
主线程 UI (src/ui)
  └─ LayoutEngine：Worker 生命周期与消息转发
        │  File + SRT + 参数
        ▼
Pipeline Worker (src/pipelineWorker.ts)
  ├─ Mp4Demuxer        mp4box 流式解封装，提取视频轨道压缩样本 + 重建 avcC
  ├─ FrameDecoder      WebCodecs VideoDecoder 硬解，按分析帧率抽帧
  ├─ FaceAnalyzer      MediaPipe FaceDetector，人脸框归一化
  ├─ FrameFeature*     20×36 网格：亮度/Sobel 边缘/文字检测/显著图
  └─ runLayout         镜头分割 → 障碍聚合 → 镜头内 DP 求解 → 零重叠验收
        ▼
ASS 导出 (src/core/assExport.ts)
```

### 为什么用动态规划

每条字幕有数十个候选位置（3 横档 × 多纵档，对话模式额外侧贴说话人）。
在一个镜头内，把「每条字幕选哪个位置」建模成序列决策：

- **硬约束**：候选与人脸/画面文字的碰撞面积，权重远高于一切软代价（字典序优先）；
- **软代价**：显著度遮挡、偏离底部偏好带、与上一条字幕的位置跳变；
- DP 在镜头的候选网格上求全局最优路径，天然保证同镜头位置不反复横跳。

障碍按字幕**整个存活区间**聚合（人脸/文字框先膨胀安全余量再合并），
而不是只看单帧，这是「重叠帧数为零」的关键。

### 关键文件

| 文件 | 职责 |
| --- | --- |
| `src/core/frameAnalysis.ts` | 网格亮度/边缘、画面文字检测、显著图 |
| `src/core/shotSegment.ts` | 镜头分割 |
| `src/core/layout/` | 候选生成、障碍聚合、说话人检测、DP 求解 |
| `src/core/assExport.ts` | ASS 与 JSON 导出 |
| `src/pipeline/` | 解封装、硬解、人脸、帧分析 |
| `src/pipelineWorker.ts` | Worker 主编排 |

## 参数说明（`src/types.ts` 的 `LayoutOptions`）

- `analysisFps`：抽帧分析帧率，默认 4，越高越精细越慢；
- `shotChangeThreshold`：镜头硬切的帧间差分阈值；
- `facePadding` / `textPadding`：障碍框外扩安全余量；
- `jumpWeight`：同镜头位置跳变惩罚；
- `brightLumaThreshold` / `busyTextureThreshold`：加底的亮度/纹理阈值；
- `dialogueWidthRatio`：双人对话窄盒相对最大宽度比例。

## 浏览器要求

需要支持 **WebCodecs**（VideoDecoder）与 **OffscreenCanvas** 的 Chromium 内核浏览器
（Chrome / Edge 较新版本）。H.264 支持最广，H.265 取决于系统硬件/许可。

## 离线与资源

- MediaPipe WASM 运行时随 `npm install` 复制到 `public/mediapipe/`；
- BlazeFace 模型存于 `public/models/`，缺失时回退公网地址；
- 无任何外部服务依赖。
