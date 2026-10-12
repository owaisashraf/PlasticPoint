import { crc32, inflateRawSync } from 'node:zlib';
import { expect } from 'vitest';

/** Reads back the one entry of a zip the way an unzip tool does: via the central directory. */
export function readSingleEntryZip(zip: Buffer): { name: string; data: Buffer; modified: { date: number; time: number } } {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  expect(zip.readUInt16LE(end + 10)).toBe(1);
  const cd = zip.readUInt32LE(end + 16);
  expect(zip.readUInt32LE(cd)).toBe(0x02014b50);
  const method = zip.readUInt16LE(cd + 10);
  const crc = zip.readUInt32LE(cd + 16);
  const compressedSize = zip.readUInt32LE(cd + 20);
  const size = zip.readUInt32LE(cd + 24);
  const nameLen = zip.readUInt16LE(cd + 28);
  const localOffset = zip.readUInt32LE(cd + 42);
  expect(zip.readUInt32LE(localOffset)).toBe(0x04034b50);
  const localNameLen = zip.readUInt16LE(localOffset + 26);
  const start = localOffset + 30 + localNameLen + zip.readUInt16LE(localOffset + 28);
  expect(method).toBe(8);
  const data = inflateRawSync(zip.subarray(start, start + compressedSize));
  expect(data.length).toBe(size);
  expect(crc32(data)).toBe(crc);
  return {
    name: zip.subarray(cd + 46, cd + 46 + nameLen).toString('utf8'),
    data,
    modified: { date: zip.readUInt16LE(cd + 14), time: zip.readUInt16LE(cd + 12) },
  };
}
