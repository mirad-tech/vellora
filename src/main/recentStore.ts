import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import type { RecentItem, RecentItemType, RecentItemsResult } from '../shared/documentTypes';

type RecentRecord = {
  type: RecentItemType;
  path: string;
  name: string;
  openedAt: number;
};

type RecentRecordInput = {
  type: RecentItemType;
  path: string;
};

export type RecentStore = {
  record: (item: RecentRecordInput) => Promise<void>;
  read: () => Promise<RecentItemsResult>;
  remove: (item: RecentRecordInput) => Promise<void>;
};

const DEFAULT_RECENT_LIMIT = 12;

async function readRecords(statePath: string): Promise<RecentRecord[]> {
  try {
    const raw = await readFile(statePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed.filter((item): item is RecentRecord => {
      return (
        typeof item === 'object' &&
        item !== null &&
        (item as RecentRecord).type !== undefined &&
        ((item as RecentRecord).type === 'file' || (item as RecentRecord).type === 'folder') &&
        typeof (item as RecentRecord).path === 'string' &&
        typeof (item as RecentRecord).name === 'string' &&
        typeof (item as RecentRecord).openedAt === 'number'
      );
    });
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') return [];
    throw error;
  }
}

async function itemExists(item: RecentRecord): Promise<boolean> {
  try {
    const info = await stat(item.path);
    return item.type === 'folder' ? info.isDirectory() : info.isFile();
  } catch {
    return false;
  }
}

function isSamePath(p1: string, p2: string): boolean {
  const r1 = resolve(p1);
  const r2 = resolve(p2);
  if (process.platform === 'win32') {
    return r1.toLowerCase() === r2.toLowerCase();
  }
  return r1 === r2;
}

export function createRecentStore(statePath: string, limit = DEFAULT_RECENT_LIMIT): RecentStore {
  let recordQueue: Promise<void> = Promise.resolve();

  async function writeRecords(records: RecentRecord[]): Promise<void> {
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify(records, null, 2), 'utf8');
  }

  async function recordNow(item: RecentRecordInput): Promise<void> {
    const resolvedPath = resolve(item.path);
    const records = await readRecords(statePath);
    const nextRecord: RecentRecord = {
      type: item.type,
      path: resolvedPath,
      name: basename(resolvedPath),
      openedAt: Date.now()
    };
    const deduped = records.filter(
      (record) => !(record.type === nextRecord.type && isSamePath(record.path, resolvedPath))
    );
    await writeRecords([nextRecord, ...deduped].slice(0, limit));
  }

  async function removeNow(item: RecentRecordInput): Promise<void> {
    const resolvedPath = resolve(item.path);
    const records = await readRecords(statePath);
    const remaining = records.filter(
      (record) => !(record.type === item.type && isSamePath(record.path, resolvedPath))
    );
    await writeRecords(remaining);
  }


  return {
    async record(item) {
      const nextRecord = recordQueue
        .catch(() => {})
        .then(() => recordNow(item));
      recordQueue = nextRecord.then(() => undefined, () => undefined);
      await nextRecord;
    },

    async remove(item) {
      const nextRecord = recordQueue
        .catch(() => {})
        .then(() => removeNow(item));
      recordQueue = nextRecord.then(() => undefined, () => undefined);
      await nextRecord;
    },

    async read() {
      try {
        const records = await readRecords(statePath);
        const items: RecentItem[] = await Promise.all(
          records.map(async (record) => ({
            ...record,
            exists: await itemExists(record)
          }))
        );

        return {
          ok: true,
          items
        };
      } catch {
        return {
          ok: false,
          code: 'RECENT_READ_FAILED',
          message: '无法读取最近打开记录。'
        };
      }
    }
  };
}
