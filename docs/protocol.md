# 穹顶讲解协议（v1）

所有消息经同源 `BroadcastChannel('dome-presenter-v1')` 传递。图片**不**
经过消息通道：观众窗按冻结节目单中的 `blobId` 直接从 IndexedDB 读取。

## 消息

| 消息 | 方向 | 关键字段 |
| --- | --- | --- |
| `CMD` | 控制台 → 观众窗 | `sessionId`, `seq`, `action`, `page`, `blackout` |
| `ACK` (`ok:true`) | 观众窗 → 控制台 | `sessionId`, `seq`, 实际呈现的 `page`/`blackout` |
| `ACK` (`ok:false`) | 观众窗 → 控制台 | `reason:'IMAGE_FAILED'`、本次尝试的 `target{page,blackout}`、回退后实际停留的 `page`/`blackout` |
| `SNAPSHOT_REQ` | 观众窗 → 控制台 | `viewerId`（启动/刷新后立即发，并每秒轮询直到拿到运行中会话） |
| `SNAPSHOT_RES` | 控制台 → 观众窗 | 定向 `viewerId`、`running`、`confirmed{seq,page,blackout}`、`pending` |
| `SESSION_ENDED` | 控制台 → 观众窗 | `sessionId` |

## 权威状态

控制台是唯一权威持有者：

- `lastConfirmed = { seq, page, blackout }`：最近一次被确认呈现的完整画面；
  会话初始为 `{ seq:0, page:0, blackout:false }`。
- `pending`：当前命令的生命周期 `pending → （ACK）清空`、
  `pending → unconfirmed（超时）→ 重试回 pending`、
  `pending → failed（IMAGE_FAILED）`。

序号规则：

- 新命令 `seq = lastConfirmed.seq + 1`，严格单调；
- `pending`/`unconfirmed` 期间不接受叠加的新命令（未确认可能已在穹顶成像，
  只能显式**重试且沿用原序号**）；
- `failed` 允许被讲解员的下一条命令取代（观众窗已回退到最后成功帧，新命令
  仍从上一权威序号递增），坏图不锁死放映；
- 控制台只接受“当前未决命令”的确认——除 `sessionId` 相同、`seq === pending.seq`
  外，**画面也必须与 `pending.target` 完全一致**：
  - 成功 ACK 的 `page/blackout` 必须等于目标；
  - 失败 ACK 比对其显式携带的 `target`（其 `page/blackout` 是回退后的最后成功帧，
    不是尝试目标）。
  多观众窗交错、失败后同序号被替代命令复用时，迟到确认即使序号相同，只要画面
  不匹配当前目标也一律丢弃——权威不可能被“同序号不同画面”的确认拉走。

## 观众窗不变量

- 启动即 `recovering`：只接受**定向给本窗口**的 `SNAPSHOT_RES`；
  恢复期间所有 `CMD` 丢弃，画面保持全黑，杜绝“刷新后闪回旧星图”。
- 恢复后 `appliedSeq = confirmed.seq`、画面直接采用 `confirmed`
  （含遮黑状态）。
- `live` 期间：
  - `seq < appliedSeq`：更旧消息，忽略；
  - `seq === appliedSeq` 且**无未决呈现**：完全重复（典型：ACK 丢失后超时重发），
    画面不动，重放当前帧 ACK；若该序号正处于异步呈现（`inFlight`）则连 ACK 都不发
    （未决呈现自身会回报，避免重放出指向旧画面的确认）；
  - `seq === appliedSeq + 1`：接受并把目标记入 `inFlight`，开始呈现；
  - 其它跳号：忽略。
- 渲染结果回调必须与当前 `inFlight`（`seq+page+blackout`）完全一致才提交，
  否则一律丢弃：旧命令、旧快照、旧失败回退的迟到结果不改状态、不发确认。
- 呈现失败：`appliedSeq` 与画面回退到最后成功帧，失败 ACK 携带**尝试目标**
  `target` 与实际停留画面，回 `ok:false`；随后同序号重试可再次被接受。
- **画面代次（epoch）**：每次有效画面来源切换（进入恢复/快照恢复/接受新命令/
  停映）都使旧代次作废。取 Blob、解码、缩放重绘、失败回退等一切异步绘制，在真正
  落到 Canvas 前必须仍是当前代次且仍是当前 `inFlight`/当前帧，否则丢弃。
  因此旧快照、窗口缩放触发的旧帧重绘、失败后的旧回退、停映前的迟到结果都不可能
  再改动画布；停映后持续黑屏。
- `sessionId` 不匹配的任何消息（含伪造的 `CMD`/`SESSION_ENDED`）一律无效。

## 持久化与恢复

- IndexedDB：
  - `blobs`：`{ blobId, blob(Blob), name }`；
  - `program`：`draft`（草稿）与 `frozen:<sessionId>`（随会话冻结的顺序）；
  - `session`：`current`（运行中会话的完整权威状态）。
- 控制台刷新：从 IDB 恢复会话；若存在未决命令，统一标记为 `unconfirmed`
  （不自动重发，由讲解员决定，序号不变）。
- 观众窗刷新/重开：`SNAPSHOT_REQ` → 读取该会话冻结节目单 → 应用
  `confirmed` 快照 → 进入 `live`。
- 收敛终点：控制台“已呈现（权威）”标记与穹顶实际画面始终等于同一个
  `lastConfirmed`。

## 超时

默认 ACK 超时 `1500ms`（`DEFAULT_ACK_TIMEOUT_MS`），控制台每 200ms 巡检。
超时只改标记，绝不改变 `lastConfirmed`。
