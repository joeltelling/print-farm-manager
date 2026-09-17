// Small fixed QR encoder for local work-order URLs.
// QR version 5, error correction level L, byte mode, mask 0.
const VERSION = 5;
const SIZE = 37;
const DATA_CODEWORDS = 108;
const ECC_CODEWORDS = 26;

function appendBits(bits, value, length) {
  for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

function multiply(a, b) {
  let result = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) result ^= a;
    const high = a & 0x80;
    a = (a << 1) & 0xff;
    if (high) a ^= 0x1d;
    b >>>= 1;
  }
  return result;
}

function reedSolomonDivisor(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = multiply(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = multiply(root, 2);
  }
  return result;
}

function reedSolomonRemainder(data, divisor) {
  const result = new Uint8Array(divisor.length);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < result.length; i++) result[i] ^= multiply(divisor[i], factor);
  }
  return result;
}

function makeCodewords(text) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > 106) throw new Error('QR completion URL is too long');
  const bits = [];
  appendBits(bits, 0x4, 4);
  appendBits(bits, bytes.length, 8);
  for (const byte of bytes) appendBits(bits, byte, 8);
  appendBits(bits, 0, Math.min(4, DATA_CODEWORDS * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j++) value = (value << 1) | bits[i + j];
    data.push(value);
  }
  for (let pad = 0; data.length < DATA_CODEWORDS; pad++) data.push(pad % 2 ? 0x11 : 0xec);
  const ecc = reedSolomonRemainder(data, reedSolomonDivisor(ECC_CODEWORDS));
  return [...data, ...ecc];
}

function makeMatrix(text) {
  const modules = Array.from({ length: SIZE }, () => Array(SIZE).fill(false));
  const isFunction = Array.from({ length: SIZE }, () => Array(SIZE).fill(false));
  const setFunction = (x, y, dark) => {
    modules[y][x] = dark;
    isFunction[y][x] = true;
  };

  const drawFinder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue;
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        setFunction(x, y, distance !== 2 && distance !== 4);
      }
    }
  };
  const drawAlignment = (cx, cy) => {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  };

  for (let i = 0; i < SIZE; i++) {
    setFunction(6, i, i % 2 === 0);
    setFunction(i, 6, i % 2 === 0);
  }
  drawFinder(3, 3);
  drawFinder(SIZE - 4, 3);
  drawFinder(3, SIZE - 4);
  drawAlignment(30, 30);

  const format = 0x77c4;
  for (let i = 0; i <= 5; i++) setFunction(8, i, ((format >>> i) & 1) !== 0);
  setFunction(8, 7, ((format >>> 6) & 1) !== 0);
  setFunction(8, 8, ((format >>> 7) & 1) !== 0);
  setFunction(7, 8, ((format >>> 8) & 1) !== 0);
  for (let i = 9; i < 15; i++) setFunction(14 - i, 8, ((format >>> i) & 1) !== 0);
  for (let i = 0; i < 8; i++) setFunction(SIZE - 1 - i, 8, ((format >>> i) & 1) !== 0);
  for (let i = 8; i < 15; i++) setFunction(8, SIZE - 15 + i, ((format >>> i) & 1) !== 0);
  setFunction(8, SIZE - 8, true);

  const codewords = makeCodewords(text);
  let bitIndex = 0;
  let upward = true;
  for (let right = SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right--;
    for (let vert = 0; vert < SIZE; vert++) {
      const y = upward ? SIZE - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        if (isFunction[y][x]) continue;
        const bit = bitIndex < codewords.length * 8
          ? ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) !== 0
          : false;
        modules[y][x] = bit !== ((x + y) % 2 === 0);
        bitIndex++;
      }
    }
    upward = !upward;
  }
  return modules;
}

export function qrSvgDataUrl(text, scale = 5, border = 4) {
  const modules = makeMatrix(text);
  const dimension = (SIZE + border * 2) * scale;
  const cells = [];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (modules[y][x]) cells.push(`<rect x="${(x + border) * scale}" y="${(y + border) * scale}" width="${scale}" height="${scale}"/>`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dimension} ${dimension}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white"/><g fill="black">${cells.join('')}</g></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export const QR_VERSION = VERSION;
