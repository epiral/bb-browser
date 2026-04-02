declare module "ws" {
  import { EventEmitter } from "node:events";
  import type { IncomingMessage, ClientRequest } from "node:http";
  import type { Duplex } from "node:stream";

  namespace WebSocket {
    type RawData = Buffer | ArrayBuffer | Buffer[];
    const OPEN: number;
    const CLOSED: number;
    const CONNECTING: number;
    const CLOSING: number;
  }

  class WebSocket extends EventEmitter {
    static readonly OPEN: number;
    static readonly CLOSED: number;
    static readonly CONNECTING: number;
    static readonly CLOSING: number;

    constructor(address: string | URL, options?: object);

    readyState: number;
    url: string;

    close(code?: number, reason?: string | Buffer): void;
    send(data: string | Buffer | ArrayBuffer | Buffer[], cb?: (err?: Error) => void): void;
    ping(data?: unknown, mask?: boolean, cb?: (err: Error) => void): void;
    pong(data?: unknown, mask?: boolean, cb?: (err: Error) => void): void;
    terminate(): void;

    on(event: "close", listener: (code: number, reason: Buffer) => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: "message", listener: (data: WebSocket.RawData, isBinary: boolean) => void): this;
    on(event: "open", listener: () => void): this;
    on(event: "ping" | "pong", listener: (data: Buffer) => void): this;
    on(event: string | symbol, listener: (...args: unknown[]) => void): this;

    once(event: "close", listener: (code: number, reason: Buffer) => void): this;
    once(event: "error", listener: (err: Error) => void): this;
    once(event: "message", listener: (data: WebSocket.RawData, isBinary: boolean) => void): this;
    once(event: "open", listener: () => void): this;
    once(event: string | symbol, listener: (...args: unknown[]) => void): this;

    off(event: "message", listener: (data: WebSocket.RawData, isBinary: boolean) => void): this;
    off(event: string | symbol, listener: (...args: unknown[]) => void): this;
  }

  export = WebSocket;
}
