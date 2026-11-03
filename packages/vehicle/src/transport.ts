/**
 * A byte pipe to the vehicle. Implementations: Web Serial (browser/Electron), Electron serial,
 * TCP (SITL, Node), UDP (later: ELRS WiFi). The vehicle layer never knows which one it has.
 */
export interface Transport {
  write(bytes: Uint8Array): Promise<void>;
  /** Register the single data sink. Called with chunks in arrival order. */
  onData(cb: (bytes: Uint8Array) => void): void;
  onClose(cb: (err?: Error) => void): void;
  close(): Promise<void>;
  readonly description: string;
}
