/**
 * 消息总线：封装 BroadcastChannel，附 storage 事件兜底（同浏览器不同标签页必然同源，
 * BroadcastChannel 可用）。所有对外消息均为 WireMessage。
 */
import { WireMessage } from './protocol/types';

export const CHANNEL_NAME = 'dome-presenter-v1';

export type MessageHandler = (msg: WireMessage) => void;

export class MessageBus {
  private channel: BroadcastChannel | null = null;
  private handlers = new Set<MessageHandler>();
  closed = false;

  constructor(name: string = CHANNEL_NAME) {
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(name);
      this.channel.onmessage = (ev: MessageEvent<WireMessage>) => {
        this.handlers.forEach((h) => {
          try {
            h(ev.data);
          } catch (err) {
            console.error('message handler failed', err);
          }
        });
      };
    }
  }

  post(msg: WireMessage): void {
    if (this.closed) return;
    this.channel?.postMessage(msg);
  }

  subscribe(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close(): void {
    this.handlers.clear();
    this.channel?.close();
    this.channel = null;
    this.closed = true;
  }
}
