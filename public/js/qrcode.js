// Pure ES-module ISO/IEC 18004 QR Code SVG generator (Versions 1-8, Error Correction Level L, Byte Mode)

const VERSION_SPECS = [
  null,
  { version: 1, size: 21, dataCodewords: 19, ecPerBlock: 7, blocks: 1, align: [] },
  { version: 2, size: 25, dataCodewords: 34, ecPerBlock: 10, blocks: 1, align: [6, 18] },
  { version: 3, size: 29, dataCodewords: 55, ecPerBlock: 15, blocks: 1, align: [6, 22] },
  { version: 4, size: 33, dataCodewords: 80, ecPerBlock: 20, blocks: 1, align: [6, 26] },
  { version: 5, size: 37, dataCodewords: 108, ecPerBlock: 26, blocks: 1, align: [6, 30] },
  { version: 6, size: 41, dataCodewords: 136, ecPerBlock: 18, blocks: 2, align: [6, 34] },
  { version: 7, size: 45, dataCodewords: 156, ecPerBlock: 20, blocks: 2, align: [6, 22, 38] },
  { version: 8, size: 49, dataCodewords: 194, ecPerBlock: 24, blocks: 2, align: [6, 24, 42] },
];

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(function initGaloisField() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) {
      x ^= 0x11d;
    }
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function buildRsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    const root = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], root);
    }
    poly = next;
  }
  return poly;
}

function computeRsEcc(data, ecLength) {
  const gen = buildRsGenerator(ecLength);
  const res = new Uint8Array(ecLength);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ res[0];
    res.copyWithin(0, 1);
    res[ecLength - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < ecLength; j++) {
        res[j] ^= gfMul(gen[j + 1], factor);
      }
    }
  }
  return res;
}

function chooseSpec(byteLen) {
  for (let v = 1; v < VERSION_SPECS.length; v++) {
    const spec = VERSION_SPECS[v];
    const maxBytes = Math.floor((spec.dataCodewords * 8 - 12) / 8);
    if (byteLen <= maxBytes) {
      return spec;
    }
  }
  throw new Error(`QR payload too long (${byteLen} bytes, max 192 bytes)`);
}

function encodeDataCodewords(bytes, spec) {
  const totalBits = spec.dataCodewords * 8;
  const bits = [];

  const pushBits = (value, count) => {
    for (let i = count - 1; i >= 0; i--) {
      bits.push((value >>> i) & 1);
    }
  };

  // Mode: Byte (0100), Length: 8 bits (valid for versions 1-9)
  pushBits(0b0100, 4);
  pushBits(bytes.length, 8);
  for (let i = 0; i < bytes.length; i++) {
    pushBits(bytes[i], 8);
  }

  // Terminator (up to 4 zero bits)
  const terminatorLen = Math.min(4, totalBits - bits.length);
  for (let i = 0; i < terminatorLen; i++) {
    bits.push(0);
  }

  // Pad to byte boundary
  while (bits.length % 8 !== 0) {
    bits.push(0);
  }

  const codewords = new Uint8Array(spec.dataCodewords);
  for (let i = 0; i < bits.length / 8; i++) {
    let val = 0;
    for (let b = 0; b < 8; b++) {
      val = (val << 1) | bits[i * 8 + b];
    }
    codewords[i] = val;
  }

  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  for (let i = bits.length / 8; i < spec.dataCodewords; i++) {
    codewords[i] = padBytes[padIdx];
    padIdx ^= 1;
  }

  return codewords;
}

function interleaveCodewords(dataCodewords, spec) {
  const blockSize = spec.dataCodewords / spec.blocks;
  const dataBlocks = [];
  const eccBlocks = [];

  for (let b = 0; b < spec.blocks; b++) {
    const start = b * blockSize;
    const block = dataCodewords.subarray(start, start + blockSize);
    dataBlocks.push(block);
    eccBlocks.push(computeRsEcc(block, spec.ecPerBlock));
  }

  const result = [];
  for (let i = 0; i < blockSize; i++) {
    for (let b = 0; b < spec.blocks; b++) {
      result.push(dataBlocks[b][i]);
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (let b = 0; b < spec.blocks; b++) {
      result.push(eccBlocks[b][i]);
    }
  }
  return result;
}

function computeFormatBits(maskIndex) {
  // Error correction level L = 01
  const data = (0b01 << 3) | maskIndex;
  let rem = data << 10;
  const gen = 0x537;
  for (let i = 14; i >= 10; i--) {
    if ((rem >>> i) & 1) {
      rem ^= gen << (i - 10);
    }
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function computeVersionBits(version) {
  let rem = version << 12;
  const gen = 0x1f25;
  for (let i = 17; i >= 12; i--) {
    if ((rem >>> i) & 1) {
      rem ^= gen << (i - 12);
    }
  }
  return (version << 12) | rem;
}

function createMatrix(spec) {
  const n = spec.size;
  const modules = Array.from({ length: n }, () => new Uint8Array(n));
  const reserved = Array.from({ length: n }, () => new Uint8Array(n));

  const setFunctionModule = (r, c, dark) => {
    if (r < 0 || r >= n || c < 0 || c >= n) return;
    modules[r][c] = dark ? 1 : 0;
    reserved[r][c] = 1;
  };

  const drawFinder = (top, left) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = top + dr;
        const c = left + dc;
        if (r < 0 || r >= n || c < 0 || c >= n) continue;
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const onOuterBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inInner = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setFunctionModule(r, c, inOuter && (onOuterBorder || inInner));
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(0, n - 7);
  drawFinder(n - 7, 0);

  // Timing patterns
  for (let i = 8; i < n - 8; i++) {
    const dark = i % 2 === 0;
    setFunctionModule(6, i, dark);
    setFunctionModule(i, 6, dark);
  }

  // Alignment patterns
  for (const ar of spec.align) {
    for (const ac of spec.align) {
      const overlapsFinder =
        (ar <= 8 && ac <= 8) ||
        (ar <= 8 && ac >= n - 9) ||
        (ar >= n - 9 && ac <= 8);
      if (overlapsFinder) continue;

      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const isDark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          setFunctionModule(ar + dr, ac + dc, isDark);
        }
      }
    }
  }

  // Dark module
  setFunctionModule(4 * spec.version + 9, 8, true);

  // Reserve format information cells
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      reserved[8][i] = 1;
      reserved[i][8] = 1;
    }
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][n - 1 - i] = 1;
  }
  for (let i = 0; i < 7; i++) {
    reserved[n - 1 - i][8] = 1;
  }

  // Reserve & write version information if version >= 7
  if (spec.version >= 7) {
    const vBits = computeVersionBits(spec.version);
    for (let i = 0; i < 18; i++) {
      const bit = ((vBits >>> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = n - 11 + (i % 3);
      setFunctionModule(a, b, bit);
      setFunctionModule(b, a, bit);
    }
  }

  return { modules, reserved, size: n };
}

function writeFormatInfo(modules, size, maskIndex) {
  const bits = computeFormatBits(maskIndex);

  for (let i = 0; i <= 5; i++) {
    const bit = ((bits >>> i) & 1) === 1 ? 1 : 0;
    modules[8][i] = bit;
  }
  modules[8][7] = ((bits >>> 6) & 1) === 1 ? 1 : 0;
  modules[8][8] = ((bits >>> 7) & 1) === 1 ? 1 : 0;
  modules[7][8] = ((bits >>> 8) & 1) === 1 ? 1 : 0;
  for (let i = 9; i < 15; i++) {
    modules[14 - i][8] = ((bits >>> i) & 1) === 1 ? 1 : 0;
  }

  for (let i = 0; i < 7; i++) {
    modules[size - 1 - i][8] = ((bits >>> i) & 1) === 1 ? 1 : 0;
  }
  for (let i = 7; i < 15; i++) {
    modules[8][size - 15 + i] = ((bits >>> i) & 1) === 1 ? 1 : 0;
  }
}

function placeDataBits(modules, reserved, size, codewords) {
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  let upward = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      const r = upward ? size - 1 - vert : vert;
      for (let lr = 0; lr < 2; lr++) {
        const c = right - lr;
        if (reserved[r][c]) continue;
        let bit = 0;
        if (bitIndex < totalBits) {
          const byteVal = codewords[bitIndex >>> 3];
          bit = (byteVal >>> (7 - (bitIndex & 7))) & 1;
          bitIndex++;
        }
        modules[r][c] = bit;
      }
    }
    upward = !upward;
  }
}

const MASK_FNS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function cloneWithMask(baseModules, reserved, size, maskIndex) {
  const maskFn = MASK_FNS[maskIndex];
  const grid = baseModules.map((row, r) => {
    const out = new Uint8Array(size);
    for (let c = 0; c < size; c++) {
      out[c] = reserved[r][c] ? row[c] : row[c] ^ (maskFn(r, c) ? 1 : 0);
    }
    return out;
  });
  writeFormatInfo(grid, size, maskIndex);
  return grid;
}

function scoreMatrix(grid, size) {
  let penalty = 0;

  // N1: adjacent same-color modules in row/col (5+ in a row)
  for (let r = 0; r < size; r++) {
    let runColor = grid[r][0];
    let runLen = 1;
    for (let c = 1; c < size; c++) {
      if (grid[r][c] === runColor) {
        runLen++;
      } else {
        if (runLen >= 5) penalty += 3 + (runLen - 5);
        runColor = grid[r][c];
        runLen = 1;
      }
    }
    if (runLen >= 5) penalty += 3 + (runLen - 5);
  }

  for (let c = 0; c < size; c++) {
    let runColor = grid[0][c];
    let runLen = 1;
    for (let r = 1; r < size; r++) {
      if (grid[r][c] === runColor) {
        runLen++;
      } else {
        if (runLen >= 5) penalty += 3 + (runLen - 5);
        runColor = grid[r][c];
        runLen = 1;
      }
    }
    if (runLen >= 5) penalty += 3 + (runLen - 5);
  }

  // N2: 2x2 blocks of same color
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const color = grid[r][c];
      if (
        grid[r][c + 1] === color &&
        grid[r + 1][c] === color &&
        grid[r + 1][c + 1] === color
      ) {
        penalty += 3;
      }
    }
  }

  // N3: finder-like 1:1:3:1:1 patterns
  const matchPattern = (arr, start) => {
    const p1 =
      arr[start] === 1 &&
      arr[start + 1] === 0 &&
      arr[start + 2] === 1 &&
      arr[start + 3] === 1 &&
      arr[start + 4] === 1 &&
      arr[start + 5] === 0 &&
      arr[start + 6] === 1;
    if (!p1) return false;
    const beforeClear =
      start >= 4 &&
      arr[start - 1] === 0 &&
      arr[start - 2] === 0 &&
      arr[start - 3] === 0 &&
      arr[start - 4] === 0;
    const afterClear =
      start + 10 < arr.length &&
      arr[start + 7] === 0 &&
      arr[start + 8] === 0 &&
      arr[start + 9] === 0 &&
      arr[start + 10] === 0;
    return beforeClear || afterClear;
  };

  for (let r = 0; r < size; r++) {
    for (let c = 0; c <= size - 7; c++) {
      if (matchPattern(grid[r], c)) penalty += 40;
    }
  }
  const colArr = new Uint8Array(size);
  for (let c = 0; c < size; c++) {
    for (let r = 0; r < size; r++) colArr[r] = grid[r][c];
    for (let r = 0; r <= size - 7; r++) {
      if (matchPattern(colArr, r)) penalty += 40;
    }
  }

  // N4: balance of dark modules
  let darkCount = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      darkCount += grid[r][c];
    }
  }
  const total = size * size;
  const percentDiff = Math.abs((darkCount * 100) / total - 50);
  penalty += Math.floor(percentDiff / 5) * 10;

  return penalty;
}

export function encodeQrMatrix(text) {
  const bytes = new TextEncoder().encode(String(text));
  const spec = chooseSpec(bytes.length);
  const dataCodewords = encodeDataCodewords(bytes, spec);
  const finalCodewords = interleaveCodewords(dataCodewords, spec);
  const { modules, reserved, size } = createMatrix(spec);
  placeDataBits(modules, reserved, size, finalCodewords);

  let bestGrid = null;
  let bestScore = Infinity;

  for (let mask = 0; mask < 8; mask++) {
    const candidate = cloneWithMask(modules, reserved, size, mask);
    const score = scoreMatrix(candidate, size);
    if (score < bestScore) {
      bestScore = score;
      bestGrid = candidate;
    }
  }

  return { grid: bestGrid, size, version: spec.version };
}

export function generateQrSvg(text, options = {}) {
  const margin = Number.isFinite(options.margin) ? options.margin : 2;
  const darkColor = options.darkColor || '#0b0e14';
  const lightColor = options.lightColor || '#ffffff';
  const { grid, size } = encodeQrMatrix(text);
  const viewSize = size + margin * 2;

  const segments = [];
  for (let r = 0; r < size; r++) {
    let c = 0;
    while (c < size) {
      if (grid[r][c] === 1) {
        const start = c;
        while (c < size && grid[r][c] === 1) c++;
        const len = c - start;
        segments.push(`M${start + margin} ${r + margin}h${len}v1h-${len}z`);
      } else {
        c++;
      }
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewSize} ${viewSize}" shape-rendering="crispEdges" role="img" aria-label="Room QR Code">` +
    `<rect width="${viewSize}" height="${viewSize}" fill="${lightColor}" rx="2"/>` +
    `<path d="${segments.join('')}" fill="${darkColor}"/>` +
    `</svg>`
  );
}
