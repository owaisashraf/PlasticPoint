import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readSingleEntryZip } from '../../test/zip';
import { zipSingleFile } from './zip';

describe('zipSingleFile', () => {
  it('round-trips the file with its name, checksum and date', async () => {
    const data = Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(100_000, 7), randomBytes(5_000)]);
    const zip = await zipSingleFile('shopledger-2026-10-13_2100.db', data, new Date(2026, 9, 13, 21, 0, 30));
    const entry = readSingleEntryZip(zip);
    expect(entry.name).toBe('shopledger-2026-10-13_2100.db');
    expect(entry.data.equals(data)).toBe(true);
    expect(entry.modified).toEqual({ date: ((2026 - 1980) << 9) | (10 << 5) | 13, time: (21 << 11) | (0 << 5) | 15 });
    // Mostly-repeated data compresses well.
    expect(zip.length).toBeLessThan(data.length / 5);
  });

  it('handles an empty file', async () => {
    const entry = readSingleEntryZip(await zipSingleFile('empty.db', Buffer.alloc(0), new Date(2026, 0, 1)));
    expect(entry.data.length).toBe(0);
  });
});
