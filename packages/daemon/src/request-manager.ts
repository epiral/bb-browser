/**
 * Pending 请求管理
 *
 * 职责：
 * - 管理等待响应的请求
 * - 超时处理
 * - 匹配请求和响应
 */

import type { Response } from "@bb-browser/shared";
import { COMMAND_TIMEOUT } from "@bb-browser/shared";

interface PendingRequest {
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

/**
 * 请求管理器
 */
export class RequestManager {
  private pending = new Map<string, PendingRequest>();

  /**
   * 获取等待中的请求数量
   */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * 添加一个 pending 请求
   */
  add(
    requestId: string,
    resolve: (response: Response) => void,
    reject: (error: Error) => void
  ): void {
    // 设置超时
    const timeout = setTimeout(() => {
      this.timeout(requestId);
    }, COMMAND_TIMEOUT);

    this.pending.set(requestId, { resolve, reject, timeout });
  }

  /**
   * 解决一个 pending 请求
   * @returns 是否找到并解决了请求
   */
  resolve(requestId: string, response: Response): boolean {
    const pendingRequest = this.pending.get(requestId);

    if (!pendingRequest) {
      return false;
    }

    // 清理
    clearTimeout(pendingRequest.timeout);
    this.pending.delete(requestId);

    // 解决 Promise
    pendingRequest.resolve(response);
    return true;
  }

  /**
   * 请求超时处理
   */
  private timeout(requestId: string): void {
    const pendingRequest = this.pending.get(requestId);

    if (!pendingRequest) {
      return;
    }

    this.pending.delete(requestId);
    pendingRequest.reject(new Error("Command timeout"));
  }

  /**
   * 清理所有 pending 请求
   */
  clear(): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error("Daemon shutting down"));
    }
    this.pending.clear();
  }
}
