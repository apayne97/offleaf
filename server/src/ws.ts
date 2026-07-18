/**
 * WsHub — a minimal WebSocket fan-out. OffLeaf is single-user, so every
 * connected socket receives every compile event; the client filters by jobId
 * if it wants to. Messages are the ServerMessage union from @offleaf/shared.
 *
 * We type the socket structurally (WsLike) rather than importing from `ws`,
 * so the hub does not depend on that package's type declarations.
 */
import type { ServerMessage } from "@offleaf/shared";

export interface WsLike {
  readyState: number; // 1 === OPEN
  send(data: string): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

export class WsHub {
  private sockets = new Set<WsLike>();

  add(socket: WsLike): void {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => this.sockets.delete(socket));
  }

  broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const s of this.sockets) {
      if (s.readyState === 1) s.send(data);
    }
  }
}
