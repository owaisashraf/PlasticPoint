import { promisify } from 'node:util';
import { crc32, deflateRaw } from 'node:zlib';

const deflate = promisify(deflateRaw);

/** Date and time in the MS-DOS format ZIP headers use (local time, 2-second steps). */
function dosDateTime(d: Date): { date: number; time: number } {
  const year = Math.max(d.getFullYear(), 1980);
  return {
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
  };
}

/**
 * A .zip holding one file, built with Node's own zlib (no dependency).
 * Windows Explorer opens it without extra software. Files over 4 GB (ZIP64)
 * are not supported; a shop database is far smaller.
 */
export async function zipSingleFile(name: string, data: Buffer, modified: Date): Promise<Buffer> {
  if (data.length >= 0xffffffff) throw new Error('File too large to zip.');
  const compressed = await deflate(data, { level: 9 });
  const fileName = Buffer.from(name, 'utf8');
  const crc = crc32(data);
  const { date, time } = dosDateTime(modified);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // local file header
  local.writeUInt16LE(20, 4); // version needed: 2.0 (deflate)
  local.writeUInt16LE(0x0800, 6); // flags: UTF-8 name
  local.writeUInt16LE(8, 8); // method: deflate
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(fileName.length, 26);
  local.writeUInt16LE(0, 28); // extra field length

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); // central directory header
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(date, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(fileName.length, 28);
  // extra length, comment length, disk number, internal and external attributes: 0
  central.writeUInt32LE(0, 42); // offset of the local header

  const centralOffset = local.length + fileName.length + compressed.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(1, 8); // entries on this disk
  end.writeUInt16LE(1, 10); // entries in total
  end.writeUInt32LE(central.length + fileName.length, 12);
  end.writeUInt32LE(centralOffset, 16);

  return Buffer.concat([local, fileName, compressed, central, fileName, end]);
}
