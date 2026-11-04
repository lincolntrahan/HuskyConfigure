/**
 * Parameter backups. In the browser they live in IndexedDB (per machine, survives reloads);
 * a memory store is used where IndexedDB doesn't exist (Node tests).
 * The UI can always export any backup as a Mission Planner .param file.
 */
export interface BackupRecord {
  id: string;
  savedAt: string;
  reason: string;
  boardUid: string;
  target: string;
  firmware: string;
  params: { name: string; value: number; type: number }[];
}

export interface BackupStore {
  put(b: BackupRecord): Promise<void>;
  list(boardUid?: string): Promise<BackupRecord[]>;
  get(id: string): Promise<BackupRecord | undefined>;
}

export function memoryBackupStore(): BackupStore {
  const m = new Map<string, BackupRecord>();
  return {
    put: async (b) => { m.set(b.id, b); },
    list: async (uid) => [...m.values()].filter((b) => !uid || b.boardUid === uid).sort((a, b) => b.savedAt.localeCompare(a.savedAt)),
    get: async (id) => m.get(id),
  };
}

export function indexedDbBackupStore(dbName = "huskyconfigure"): BackupStore {
  const open = () => new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("backups", { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const tx = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const t = db.transaction("backups", mode);
      const r = fn(t.objectStore("backups"));
      t.oncomplete = () => { db.close(); resolve(r.result); };
      t.onerror = () => { db.close(); reject(t.error); };
    });
  };
  return {
    put: async (b) => { await tx("readwrite", (s) => s.put(b)); },
    list: async (uid) => {
      const all = await tx<BackupRecord[]>("readonly", (s) => s.getAll() as IDBRequest<BackupRecord[]>);
      return all.filter((b) => !uid || b.boardUid === uid).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    },
    get: (id) => tx<BackupRecord | undefined>("readonly", (s) => s.get(id) as IDBRequest<BackupRecord | undefined>),
  };
}

/** Mission Planner-compatible .param text. JS prints float32 values exactly, so restores are bit-exact. */
export function toParamFile(b: BackupRecord): string {
  const head = `# HuskyConfigure backup ${b.savedAt} (${b.reason})\n# ${b.target} fw ${b.firmware} uid ${b.boardUid}\n`;
  return head + [...b.params].sort((x, y) => x.name.localeCompare(y.name)).map((p) => `${p.name},${p.value}`).join("\n") + "\n";
}

/** Parse a .param file (Mission Planner "NAME,VALUE" or QGC/MAVProxy "NAME VALUE"). */
export function parseParamFile(text: string): { name: string; value: number }[] {
  const out: { name: string; value: number }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Z0-9_]{1,16})[,\s]+(-?[0-9.eE+-]+)/.exec(line);
    if (m) out.push({ name: m[1]!, value: Number(m[2]) });
  }
  return out;
}
