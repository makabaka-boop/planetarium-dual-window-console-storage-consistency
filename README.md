# 穹顶讲解 · Dome Presenter

纯前端的“穹顶讲解”放映系统：讲解员在**控制台**窗口编排节目单并遥控，
独立的**观众窗（穹顶）**只显示当前权威画面。无后端、无任何外部网络调用，
图片 Blob、节目单顺序与会话状态全部保存在浏览器 IndexedDB 中。

## 核心保证

- **刷新/重开不回跳旧星图**：观众窗启动时进入“恢复态”，主动向控制台请求
  最后已确认页 + 遮黑状态的**完整快照**；恢复完成前，旧命令、旧确认、其它
  会话的消息全部无效。画面只能来自快照或严格相邻序号的新命令。
- **控制台不误报未呈现的页**：命令发出后仅显示“待确认”，收到匹配序号的 ACK
  才把页标记为“已呈现（权威）”；超时显示“未确认”，呈现失败回传后显示
  “呈现失败”，**最后成功页不变**。
- **单调递增序号 + 会话隔离**：每条命令携带 `sessionId` 与严格递增 `seq`；
  重试沿用原序号。观众窗忽略更旧消息（`seq < appliedSeq`），对完全重复
  （`seq === appliedSeq`，用于 ACK 丢失后的重发）画面不动、只重放 ACK。
- **任一时刻只有当前有效画面能提交**：取 Blob/解码/缩放重绘/失败回退都是异步的，
  观众窗以“代次（epoch）+ 当前未决目标”双重闸门校验每一次画布提交——旧快照、
  窗口缩放触发的旧帧重绘、坏图失败后的旧回退、停映前的迟到结果全部作废，
  不得覆盖已确认的新页；停映后持续黑屏。
- **确认必须匹配当前目标**：控制台只接受 `sessionId`、`seq` **且画面
  （page/blackout）** 都与当前待确认目标一致的 ACK；多观众窗交错时“同序号但
  不同画面”的确认（含失败后序号复用的迟到失败确认）一律不推进权威状态，页面
  标记、持久化会话与穹顶像素不会分裂。
- **冻结节目单**：开始放映即冻结当前节目单；之后的任何编辑只改草稿、
  只影响下一会话。
- **单张失败只标记该项**：导入时逐张解码探测，失败仅在该项标记；放映中
  该页呈现失败回传 `IMAGE_FAILED`，不影响其它页，也不会锁死整场放映
  （可跳往其它好页）。
- **POPUP_BLOCKED**：浏览器拦截弹窗时显示 `POPUP_BLOCKED`，会话已建立并
  持久保留；稍后放行/手动打开观众窗仍通过快照精确同步。
- **存储失败有确定的权威状态**：IndexedDB 配额不足、权限收回或事务最终
  中止时，所有提交以**事务 `oncomplete`** 为准（请求成功、事务 abort 绝不
  误报已保存）；开始放映（冻结节目单+会话）与导入图片（Blob+草稿）是跨
  store 原子事务。一切状态变更“先落库、后宣布”——未持久化的会话/命令不会
  被宣布成功，命令不会在落库前发往观众窗；确认落库失败时页面不显示已确认、
  磁盘保留未确认命令；停映删除失败时会话仍在运行（不发 SESSION_ENDED），
  **已结束会话不复活、运行会话不假死、失败期间不覆盖最后可恢复记录**。
  控制台对每次失败给出 `STORAGE_ERROR` 可重试横幅；命令/ACK 失败刷新后仍有
  “重试未持久化的切换”入口（沿用原序号），重试后控制台、观众窗与磁盘记录
  重新收敛到同一权威。

## 页面

| 路由 | 作用 |
| --- | --- |
| `/` 或 `/console` | 讲解员控制台：选图、编排、预览、开始/结束放映、上下页/跳页/遮黑 |
| `/viewer` | 观众窗（穹顶）：全屏 Canvas，恢复态后只渲染权威画面 |

## 本地开发

```bash
npm ci
npm run dev        # http://localhost:5173/console
npm test           # Vitest：协议状态机（控制台 + 观众窗）
npm run e2e        # Playwright：多窗口操作（需已安装 Chromium）
npm run build      # 类型检查 + 生产构建到 dist/
npm run preview    # 本地预览生产产物
```

## Docker

页面端口可用环境变量 `WEB_PORT` 覆盖（默认 `8080`）：

```bash
docker compose up --build web                 # http://localhost:8080/console
WEB_PORT=9000 docker compose up --build web   # http://localhost:9000/console
```

一次性验收服务 `verify`（启动 web、等健康检查通过、在含浏览器依赖的
Playwright 镜像里跑全部 E2E，结束即退出，退出码即验收结果）：

```bash
docker compose run --rm verify
# 或
docker compose up --build --abort-on-container-exit verify
```

## 架构

```
src/
  protocol/
    types.ts      消息与状态类型（CMD/ACK/SNAPSHOT_REQ/SNAPSHOT_RES/SESSION_ENDED）
    console.ts    控制台状态机（纯函数，Vitest 核验）
    viewer.ts     观众窗状态机（纯函数，Vitest 核验）
  bus.ts          BroadcastChannel 封装
  db.ts           IndexedDB：blobs / 草稿 / 冻结节目单 / 当前会话
  image.ts        Blob 解码探测与 cover 绘制
  console/        ConsoleController：状态机 + 通道 + IDB + 超时定时器
  viewer/         ViewerRuntime：快照恢复 + 按页取 Blob + Canvas 呈现
  pages/          ConsolePage / ViewerPage（React）
tests/            Vitest 协议测试
e2e/              Playwright 多窗口测试
```

协议细节见 [`docs/protocol.md`](docs/protocol.md)。
