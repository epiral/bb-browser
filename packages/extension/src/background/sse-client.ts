/**
 * SSE Client for bb-browser Extension
 * 使用 fetch + ReadableStream 实现，兼容 Service Worker (Manifest V3)
 */

import { getUpstreamUrl, SSE_RECONNECT_DELAY, SSE_MAX_RECONNECT_ATTEMPTS } from './constants';

export interface SSEEvent {
  type: 'connected' | 'heartbeat' | 'command';
  data: unknown;
}

export interface CommandEvent {
  id: string;
  action: string;
  [key: string]: unknown;
}

export type CommandHandler = (command: CommandEvent) => void | Promise<void>;

export class SSEClient {
  private abortController: AbortController | null = null;
  private reconnectAttempts = 0;
  private isConnectedFlag = false;
  private onCommandHandler: CommandHandler | null = null;

  /**
   * 连接到 Daemon SSE 端点
   */
  async connect(): Promise<void> {
    if (this.abortController) {
      console.warn('[SSEClient] Already connected');
      return;
    }

    const baseUrl = await getUpstreamUrl();
    const sseUrl = `${baseUrl}/sse`;
    console.log('[SSEClient] Connecting to:', sseUrl);
    this.abortController = new AbortController();

    try {
      const response = await fetch(sseUrl, {
        signal: this.abortController.signal,
        headers: {
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error('Response body is null');
      }

      const contentType = response.headers.get('Content-Type');
      console.log('[SSEClient] Connection established, Content-Type:', contentType);

      this.isConnectedFlag = true;
      this.reconnectAttempts = 0;

      await this.readStream(response.body);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        console.log('[SSEClient] Connection aborted');
        return;
      }

      console.error('[SSEClient] Connection error:', error);
      this.isConnectedFlag = false;
      this.reconnect();
    }
  }

  /**
   * 读取并解析 SSE 流
   */
  private async readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let event = '';
    let data = '';

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          console.log('[SSEClient] Stream ended');
          this.isConnectedFlag = false;
          this.reconnect();
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmedLine = line.trim();

          if (trimmedLine.startsWith('event:')) {
            event = trimmedLine.substring(6).trim();
          } else if (trimmedLine.startsWith('data:')) {
            data = trimmedLine.substring(5).trim();
          } else if (trimmedLine === '') {
            if (event && data) {
              // 不 await，允许多个命令并发执行
              this.handleMessage(event, data).catch(err =>
                console.error('[SSEClient] handleMessage error:', err)
              );
              event = '';
              data = '';
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        console.log('[SSEClient] Stream reading aborted');
        return;
      }
      console.error('[SSEClient] Stream reading error:', error);
      this.isConnectedFlag = false;
      this.reconnect();
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * 处理 SSE 消息
   */
  private async handleMessage(event: string, data: string): Promise<void> {
    try {
      const parsed = JSON.parse(data);

      switch (event) {
        case 'connected':
          console.log('[SSEClient] Connection confirmed:', parsed);
          break;

        case 'heartbeat':
          console.log('[SSEClient] Heartbeat:', new Date(parsed.time * 1000).toISOString());
          break;

        case 'command':
          console.log('[SSEClient] Command received:', parsed.id, parsed.action);
          if (this.onCommandHandler) {
            await this.onCommandHandler(parsed as CommandEvent);
          } else {
            console.warn('[SSEClient] No command handler registered');
          }
          break;

        default:
          console.log('[SSEClient] Unknown event type:', event);
      }
    } catch (error) {
      console.error('[SSEClient] Error handling message:', error);
    }
  }

  /**
   * 指数退避重连
   */
  private reconnect(): void {
    if (this.reconnectAttempts >= SSE_MAX_RECONNECT_ATTEMPTS) {
      console.error('[SSEClient] Max reconnection attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = SSE_RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts - 1);

    console.log(
      `[SSEClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${SSE_MAX_RECONNECT_ATTEMPTS})`
    );

    setTimeout(() => {
      this.disconnect();
      this.connect();
    }, delay);
  }

  /**
   * 注册命令处理器
   */
  onCommand(handler: CommandHandler): void {
    this.onCommandHandler = handler;
  }

  /**
   * 断开连接
   */
  disconnect(): void {
    if (this.abortController) {
      console.log('[SSEClient] Disconnecting...');
      this.abortController.abort();
      this.abortController = null;
      this.isConnectedFlag = false;
    }
  }

  /**
   * 检查连接状态
   */
  isConnected(): boolean {
    return this.isConnectedFlag;
  }
}
