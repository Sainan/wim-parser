// Ported from wim.pluto with ChatGPT

import { open, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

function assert(cond, msg = "assertion failed") {
  if (!cond) throw new Error(msg);
}

class BinaryFile {
  constructor(handle) {
    this.handle = handle;
    this.pos = 0;
  }

  async read(n) {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await this.handle.read(buf, 0, n, this.pos);
    assert(bytesRead === n, "unexpected EOF");
    this.pos += n;
    return buf;
  }

  async seek(whence, offset) {
    if (whence === "set") this.pos = Number(offset);
    else if (whence === "cur") this.pos += Number(offset);
    else throw new Error(`bad whence: ${whence}`);
  }

  async close() {
    await this.handle.close();
  }
}

function parseResourceHeader(bin) {
  return {
    size: Number(bin.readBigUInt64LE(0) & 0x00ffffffffffffffn), // I7
    flags: bin.readUInt8(7),                                  // I1
    offset: Number(bin.readBigUInt64LE(8)),                   // I8
    original_size: Number(bin.readBigUInt64LE(16)),           // I8
  };
}

async function readWimHeader(fh) {
  const b = await fh.read(208 - 60);

  const header = {
    ImageTag: b.subarray(0, 8).toString("latin1"),
    cbSize: b.readUInt32LE(8),
    dwVersion: b.readUInt32LE(12),
    dwFlags: b.readUInt32LE(16),
    dwCompressionSize: b.readUInt32LE(20),
    gWIMGuid: b.subarray(24, 40),
    usPartNumber: b.readUInt16LE(40),
    usTotalParts: b.readUInt16LE(42),
    dwImageCount: b.readUInt32LE(44),
    rhOffsetTable: parseResourceHeader(b.subarray(48, 72)),
    rhXmlData: parseResourceHeader(b.subarray(72, 96)),
    rhBootMetadata: parseResourceHeader(b.subarray(96, 120)),
    dwBootIndex: b.readUInt32LE(120),
    rhIntegrity: parseResourceHeader(b.subarray(124, 148)),
  };

  assert(header.ImageTag === "MSWIM\0\0\0", "not a WIM file");
  assert(header.dwVersion === 0x10d00, "unsupported WIM version");

  return header;
}

async function readOffsetTable(fh, header) {
  const numResources = Math.floor(header.rhOffsetTable.size / 50);
  await fh.seek("set", header.rhOffsetTable.offset);

  const resources = [];

  for (let i = 0; i < numResources; i++) {
    const resource = parseResourceHeader(await fh.read(24));
    const extra = await fh.read(6);

    resource.part_number = extra.readUInt16LE(0);
    resource.ref_count = extra.readUInt32LE(2);
    resource.sha1 = (await fh.read(20)).toString("hex");

    resources.push(resource);
  }

  return resources;
}

function utf16ToUtf8(buf) {
  let out = "";

  for (let i = 0; i < buf.length; i += 2) {
    const codepoint = buf.readUInt16LE(i);
    assert(codepoint < 0x80, "non-ASCII UTF-16 filename not supported");
    out += String.fromCharCode(codepoint);
  }

  return out;
}

async function readDirectoryEntry(fh) {
  const len = Number((await fh.read(8)).readBigUInt64LE(0));

  if (len === 0) return null;

  const data = await fh.read(len - 8);

  const entry = {
    attributes: data.readUInt32LE(0),
    securityId: data.readInt32LE(4),
    subdirOffset: Number(data.readBigUInt64LE(8)),
    ctime: Number(data.readBigUInt64LE(32)),
    atime: Number(data.readBigUInt64LE(40)),
    mtime: Number(data.readBigUInt64LE(48)),
    sha1: data.subarray(56, 76).toString("hex"),
    streams: data.readUInt16LE(88),
    short_name_len: data.readUInt16LE(90),
    file_name_len: data.readUInt16LE(92),
  };

  assert(entry.short_name_len === 0);

  const fileNameUtf16 = data.subarray(94, 94 + entry.file_name_len);
  entry.file_name = utf16ToUtf8(fileNameUtf16);

  return entry;
}

export class Wim {
  constructor(fh) {
    this.fh = fh;
  }

  static async open(filename) {
    const handle = await open(filename, "r");
    const fh = new BinaryFile(handle);

    const wim = new Wim(fh);
    await wim.init();

    return wim;
  }

  async init() {
    this.header = await readWimHeader(this.fh);

    const resources = await readOffsetTable(this.fh, this.header);
    this.sha1ToResource = new Map();

    for (const resource of resources) {
      this.sha1ToResource.set(resource.sha1, resource);

      if (resource.flags === 2) {
        assert(!this.metadataResource, "multiple metadata resources");
        this.metadataResource = resource;
      }
    }
  }

  async getRootDirectoryEntry() {
    await this.fh.seek("set", this.metadataResource.offset);

    const securityBlockSize = (await this.fh.read(4)).readUInt32LE(0);
    await this.fh.seek("cur", securityBlockSize - 4);

    return await readDirectoryEntry(this.fh);
  }

  async listDirectory(dirEntry) {
    await this.fh.seek(
      "set",
      this.metadataResource.offset + dirEntry.subdirOffset
    );

    const entries = [];

    while (true) {
      const entry = await readDirectoryEntry(this.fh);
      if (!entry) break;
      entries.push(entry);
    }

    return entries;
  }

  async getFileContents(entry) {
    if (entry.sha1 === "0000000000000000000000000000000000000000") {
      return Buffer.alloc(0);
    }

    const resource = this.sha1ToResource.get(entry.sha1);
    assert(resource, `missing resource for ${entry.file_name}`);
    assert(resource.size === resource.original_size, "compressed resource unsupported");

    await this.fh.seek("set", resource.offset);
    return await this.fh.read(resource.size);
  }

  async extract(dirEntry, baseOutDir) {
    await mkdir(baseOutDir, { recursive: true });

    const entries = await this.listDirectory(dirEntry);

    for (const entry of entries) {
      const outPath = path.join(baseOutDir, entry.file_name);

      if (entry.subdirOffset === 0) {
        await writeFile(outPath, await this.getFileContents(entry));
      } else {
        await this.extract(entry, outPath);
      }
    }
  }

  async close() {
    await this.fh.close();
  }
}
