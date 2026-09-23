import { useEffect, useReducer, useRef, useState } from 'react';
import { ConsoleController } from '../console/ConsoleController';
import { SlideItem } from '../protocol/types';
import { Thumb } from '../components/Thumb';

export function ConsolePage() {
  const controllerRef = useRef<ConsoleController | null>(null);
  if (!controllerRef.current) controllerRef.current = new ConsoleController();
  const controller = controllerRef.current;
  const [, force] = useReducer((x: number) => x + 1, 0);
  const [selected, setSelected] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const unsub = controller.subscribe(force);
    controller.init();
    return () => {
      unsub();
      controller.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const state = controller.getState();
  const { draft, session, frozen, popup } = state;
  const pending = session?.pending ?? null;
  const currentPage = session?.lastConfirmed.page ?? 0;
  const blackout = session?.lastConfirmed.blackout ?? false;
  const running = session?.running ?? false;

  const onFiles = async (files: FileList | null) => {
    if (!files) return;
    const accepted = Array.from(files).filter((f) => /^image\/(png|jpeg|jpg)$/.test(f.type));
    await controller.addFiles(accepted);
  };

  return (
    <div className="console">
      <header className="topbar">
        <h1>穹顶讲解 · 控制台</h1>
        <div className="session-info">
          {running ? (
            <>
              <span className="badge badge-live">放映中</span>
              <span className="mono" data-testid="session-id">
                {session!.sessionId}
              </span>
            </>
          ) : (
            <span className="badge">编辑模式</span>
          )}
        </div>
      </header>

      <main className="layout">
        <section className="panel program-panel">
          <div className="panel-head">
            <h2>节目单 {frozen && <span className="frozen-note">（已冻结 · 编辑仅供下一会话）</span>}</h2>
            <button
              className="btn"
              onClick={() => fileRef.current?.click()}
              data-testid="pick-images"
            >
              选择本地 PNG/JPEG
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg"
              multiple
              hidden
              onChange={(e) => {
                void onFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </div>

          {draft.items.length === 0 && (
            <div className="empty-hint">尚未添加图片。点击右上角选择本地 PNG/JPEG 开始编排。</div>
          )}

          <ol className="slides" data-testid="slide-list">
            {draft.items.map((item, idx) => (
              <SlideRow
                key={item.id}
                item={item}
                index={idx}
                frozen={frozen}
                isCurrent={running && idx === currentPage && !blackout}
                isPendingTarget={
                  running &&
                  pending != null &&
                  idx === pending.target.page &&
                  !pending.target.blackout
                }
                pendingStatus={
                  running && pending != null && idx === pending.target.page
                    ? pending.status
                    : null
                }
                selected={selected === idx}
                onSelect={() => setSelected(idx)}
                onMoveUp={() => void controller.move(item.id, -1)}
                onMoveDown={() => void controller.move(item.id, 1)}
                onRemove={() => void controller.removeItem(item.id)}
              />
            ))}
          </ol>
        </section>

        <section className="panel show-panel">
          {!running ? (
            <div className="idle">
              <h2>准备放映</h2>
              <p className="muted">
                共 {draft.items.length} 页
                {draft.items.some((i) => i.decodeFailed) && (
                  <>
                    ，其中{' '}
                    <strong className="danger">
                      {draft.items.filter((i) => i.decodeFailed).length}
                    </strong>{' '}
                    张解码失败（仅标记该项，不影响其它页）
                  </>
                )}
              </p>
              <button
                className="btn btn-primary btn-large"
                disabled={draft.items.length === 0}
                onClick={() => void controller.startShow()}
                data-testid="start-show"
              >
                开始放映并打开观众窗
              </button>
              {popup === 'blocked' && (
                <div className="popup-blocked" data-testid="popup-blocked">
                  POPUP_BLOCKED：浏览器拦截了观众窗弹窗，会话已保留。
                  <button className="btn" onClick={() => controller.openViewer()}>
                    重试打开观众窗
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="live-controls" data-testid="live-controls">
              <div className="frame-summary">
                <div>
                  穹顶当前页：<strong data-testid="current-page">{currentPage + 1}</strong> /{' '}
                  {session!.frozenProgram.items.length}
                  {blackout && <span className="badge badge-dark">遮黑中</span>}
                </div>
                <div className="seq-line mono">
                  权威序号 seq={session!.lastConfirmed.seq}
                </div>
                <PendingIndicator pending={pending} onRetry={() => void controller.retry()} />
              </div>

              <div className="control-grid">
                <button
                  className="btn btn-large"
                  onClick={() => void controller.prev()}
                  disabled={(pending != null && pending.status !== 'failed') || currentPage === 0}
                  data-testid="prev"
                >
                  ◀ 上一页
                </button>
                <button
                  className="btn btn-large"
                  onClick={() => void controller.next()}
                  disabled={
                    (pending != null && pending.status !== 'failed') ||
                    currentPage + 1 >= session!.frozenProgram.items.length
                  }
                  data-testid="next"
                >
                  下一页 ▶
                </button>
                <GotoBox
                  total={session!.frozenProgram.items.length}
                  disabled={pending != null && pending.status !== 'failed'}
                  onGoto={(p) => void controller.goto(p)}
                />
                <button
                  className={`btn btn-large ${blackout ? 'btn-dark-on' : ''}`}
                  onClick={() => void controller.setBlackout(!blackout)}
                  disabled={pending != null && pending.status !== 'failed'}
                  data-testid="blackout"
                >
                  {blackout ? '解除遮黑' : '遮黑'}
                </button>
              </div>

              {popup === 'blocked' && (
                <div className="popup-blocked" data-testid="popup-blocked">
                  POPUP_BLOCKED：观众窗弹窗被拦截，会话仍在运行。
                  <button className="btn" onClick={() => controller.openViewer()}>
                    重试打开观众窗
                  </button>
                </div>
              )}
              <div className="viewer-count muted">
                已同步观众窗：{state.recoveringViewers}
              </div>
              <button
                className="btn btn-danger"
                onClick={() => void controller.endShow()}
                data-testid="end-show"
              >
                结束放映（节目单解冻）
              </button>
            </div>
          )}
        </section>
      </main>

      {selected !== null && draft.items[selected] && (
        <PreviewModal
          item={draft.items[selected]}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function SlideRow(props: {
  item: SlideItem;
  index: number;
  frozen: boolean;
  isCurrent: boolean;
  isPendingTarget: boolean;
  pendingStatus: 'pending' | 'unconfirmed' | 'failed' | null;
  selected: boolean;
  onSelect: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}) {
  const { item, index, frozen } = props;
  return (
    <li
      className={`slide-row ${props.isCurrent ? 'current' : ''} ${
        props.isPendingTarget ? 'pending-target' : ''
      } ${props.selected ? 'selected' : ''}`}
    >
      <span className="page-num">{index + 1}</span>
      <button className="thumb-wrap" onClick={props.onSelect} title="预览">
        {item.decodeFailed ? (
          <span className="decode-failed">解码失败</span>
        ) : (
          <Thumb blobId={item.blobId} alt={item.name} />
        )}
      </button>
      <span className="slide-name" title={item.name}>
        {item.name}
        {props.isCurrent && (
          <span className="mark mark-current" data-testid={`presented-${index}`}>
            ★ 已呈现（权威）
          </span>
        )}
        {props.pendingStatus === 'pending' && (
          <span className="mark mark-pending" data-testid={`pending-${index}`}>
            待确认…
          </span>
        )}
        {props.pendingStatus === 'unconfirmed' && (
          <span className="mark mark-unconfirmed" data-testid={`unconfirmed-${index}`}>
            未确认（可重试，序号不变）
          </span>
        )}
        {props.pendingStatus === 'failed' && (
          <span className="mark mark-failed" data-testid={`failed-${index}`}>
            呈现失败 · 最后成功页不变
          </span>
        )}
      </span>
      <span className="row-actions">
        <button className="btn btn-mini" onClick={props.onMoveUp} disabled={frozen || index === 0}>
          ↑
        </button>
        <button className="btn btn-mini" onClick={props.onMoveDown} disabled={frozen}>
          ↓
        </button>
        <button className="btn btn-mini btn-danger-mini" onClick={props.onRemove} disabled={frozen}>
          删除
        </button>
      </span>
    </li>
  );
}

function GotoBox(props: { total: number; disabled: boolean; onGoto: (page: number) => void }) {
  const [value, setValue] = useState('');
  return (
    <div className="goto">
      跳页
      <input
        type="number"
        min={1}
        max={props.total}
        value={value}
        disabled={props.disabled}
        onChange={(e) => setValue(e.target.value)}
        data-testid="goto-input"
      />
      <button
        className="btn"
        disabled={props.disabled || value === ''}
        onClick={() => {
          const n = Number(value);
          if (n >= 1 && n <= props.total) {
            props.onGoto(n - 1);
            setValue('');
          }
        }}
        data-testid="goto-go"
      >
        前往
      </button>
    </div>
  );
}

function PendingIndicator(props: {
  pending: { status: string; seq: number; attempts: number } | null;
  onRetry: () => void;
}) {
  const p = props.pending;
  if (!p) return <div className="muted ok-line">观众窗已确认，控制标记与穹顶画面一致。</div>;
  if (p.status === 'pending')
    return (
      <div className="status-line status-pending" data-testid="status-pending">
        待确认（seq={p.seq}，第 {p.attempts} 次发送）…
      </div>
    );
  if (p.status === 'unconfirmed')
    return (
      <div className="status-line status-unconfirmed" data-testid="status-unconfirmed">
        未确认（seq={p.seq}）· 画面仍停留在最后已确认页
        <button className="btn btn-mini" onClick={props.onRetry} data-testid="retry">
          重试（沿用 seq={p.seq}）
        </button>
      </div>
    );
  return (
    <div className="status-line status-failed" data-testid="status-failed">
      呈现失败（seq={p.seq}）· 最后成功页不变
      <button className="btn btn-mini" onClick={props.onRetry} data-testid="retry-failed">
        重试（沿用 seq={p.seq}）
      </button>
    </div>
  );
}

function PreviewModal(props: { item: SlideItem; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{props.item.name}</h3>
        {props.item.decodeFailed ? (
          <div className="decode-failed-large">该图片解码失败，无法呈现。</div>
        ) : (
          <Thumb blobId={props.item.blobId} alt={props.item.name} large />
        )}
        <button className="btn" onClick={props.onClose}>
          关闭
        </button>
      </div>
    </div>
  );
}
