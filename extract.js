// Ported from extract.pluto with ChatGPT

import { Wim } from "./wim.js";

const filename = process.argv[2];
if (filename) {
  const wim = await Wim.open(filename);

  try {
    const root = await wim.getRootDirectoryEntry();
    await wim.extract(root, "extracted");
  } finally {
    await wim.close();
  }
} else {
  console.log("Usage: node extract.js <path to .wim file>");
}
