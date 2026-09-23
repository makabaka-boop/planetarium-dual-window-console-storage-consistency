import { useEffect, useReducer, useRef } from 'react';
import { ViewerRuntime, PresentStatus } from '../viewer/ViewerRuntime';

export function ViewerPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<ViewerRuntime | null>(null);
  const [, force] = useReducer((x: number) => x + 1, 0);
  const statusRef = useRef<PresentStatus>({ phase: 'recovering' });

  useEffect(() => {
    if (!canvasRef.current) return;
    const runtime = new ViewerRuntime(canvasRef.current);
    runtimeRef.current = runtime;
    const unsub = runtime.subscribe(() => {
      statusRef.current = runtime.getStatus();
      force();
    });
    runtime.start();
    return () => {
      unsub();
      runtime.dispose();
    };
  }, []);

  const status = statusRef.current;

  return (
    <div className="viewer">
      <canvas ref={canvasRef} className="dome-canvas" data-testid="dome-canvas" />
      {status.phase === 'recovering' && (
        <Overlay>
          <div className="overlay-card" data-testid="viewer-recovering">
            正在从控制台恢复权威快照…
          </div>
        </Overlay>
      )}
      {status.phase === 'standby' && (
        <Overlay>
          <div className="overlay-card" data-testid="viewer-standby">
            观众窗待命。请在控制台开始放映。
          </div>
        </Overlay>
      )}
      {status.phase === 'ended' && (
        <Overlay>
          <div className="overlay-card" data-testid="viewer-ended">
            本场放映已结束。
          </div>
        </Overlay>
      )}
      {status.phase === 'live' && (
        <>
          <div className="viewer-hud" data-testid="viewer-hud">
            {status.blackout ? '遮黑' : `第 ${status.page + 1} / ${status.total} 页`}
            <span className="hud-seq mono">seq {status.seq}</span>
          </div>
          {status.imageError && (
            <div className="viewer-error" data-testid="viewer-image-error">
              该页图片呈现失败，仍显示最后成功页
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Overlay(props: { children: React.ReactNode }) {
  return <div className="viewer-overlay">{props.children}</div>;
}
