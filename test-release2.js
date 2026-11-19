import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHarmonicCurve, BASE_DELAY_SEC } from './public/js/audio-dsp.js';
import {
  FILE_CHUNK_SIZE,
  packFileChunk,
  unpackFileChunk,
  computeDriftAdjustment,
  generateTestTrackWav,
} from './public/js/tab-files.js';

function testChunkRoundTrip() {
  const totalBytes = FILE_CHUNK_SIZE * 2 + 1337;
  const original = new Uint8Array(totalBytes);
  for (let i = 0; i < totalBytes; i++) {
    original[i] = (i * 31 + 7) & 0xff;
  }

  const totalChunks = Math.ceil(totalBytes / FILE_CHUNK_SIZE);
  const reassembled = new Uint8Array(totalBytes);
  let cursor = 0;

  for (let idx = 0; idx < totalChunks; idx++) {
    const start = idx * FILE_CHUNK_SIZE;
    const end = Math.min(totalBytes, start + FILE_CHUNK_SIZE);
    const packet = packFileChunk(42, idx, totalChunks, original.subarray(start, end));
    const unpacked = unpackFileChunk(packet);
    assert.equal(unpacked.fileId, 42);
    assert.equal(unpacked.chunkIndex, idx);
    assert.equal(unpacked.totalChunks, totalChunks);
    assert.equal(unpacked.payload.byteLength, end - start);
    reassembled.set(unpacked.payload, cursor);
    cursor += unpacked.payload.byteLength;
  }

  assert.equal(cursor, totalBytes);
  assert.deepEqual(reassembled, original);
  console.log('PASS: packFileChunk / unpackFileChunk multi-chunk round-trip verified');
}

function testProceduralWavTrack() {
  const wav = generateTestTrackWav();
  assert.equal(wav.name, 'SyncStage_Beat_Test_120BPM.wav');
  assert.equal(wav.mimeType, 'audio/wav');
  assert.equal(wav.durationSec, 8);

  const expectedDataBytes = 44100 * 8 * 2 * 2;
  assert.equal(wav.arrayBuffer.byteLength, 44 + expectedDataBytes);

  const view = new DataView(wav.arrayBuffer);
  const ascii = (offset, len) => {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(offset + i));
    return s;
  };

  assert.equal(ascii(0, 4), 'RIFF');
  assert.equal(view.getUint32(4, true), 36 + expectedDataBytes);
  assert.equal(ascii(8, 4), 'WAVE');
  assert.equal(ascii(12, 4), 'fmt ');
  assert.equal(view.getUint16(20, true), 1); // PCM
  assert.equal(view.getUint16(22, true), 2); // Stereo
  assert.equal(view.getUint32(24, true), 44100);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(ascii(36, 4), 'data');
  assert.equal(view.getUint32(40, true), expectedDataBytes);

  let leftEnergy = 0;
  let rightEnergy = 0;
  for (let offset = 44; offset < wav.arrayBuffer.byteLength; offset += 4) {
    leftEnergy += Math.abs(view.getInt16(offset, true));
    rightEnergy += Math.abs(view.getInt16(offset + 2, true));
  }
  assert.ok(leftEnergy > 0 && rightEnergy > 0, 'Both stereo channels must contain audio energy');
  console.log('PASS: generateTestTrackWav 44.1 kHz stereo RIFF/WAVE synthesis verified');
}

function testDriftAdjustment() {
  // Deadband (< 12 ms) when not nudging
  assert.deepEqual(computeDriftAdjustment(0, false), { action: 'hold', rate: 1.0 });
  assert.deepEqual(computeDriftAdjustment(11.5, false), { action: 'hold', rate: 1.0 });
  assert.deepEqual(computeDriftAdjustment(-11.5, false), { action: 'hold', rate: 1.0 });

  // Gentle ±0.2% nudge between 12 ms and < 80 ms
  assert.deepEqual(computeDriftAdjustment(20, false), { action: 'nudge', rate: 0.998 });
  assert.deepEqual(computeDriftAdjustment(-20, false), { action: 'nudge', rate: 1.002 });

  // Hysteresis while already nudging (holds until < 5 ms)
  assert.deepEqual(computeDriftAdjustment(7, true), { action: 'nudge', rate: 0.998 });
  assert.deepEqual(computeDriftAdjustment(-6, true), { action: 'nudge', rate: 1.002 });
  assert.deepEqual(computeDriftAdjustment(4.5, true), { action: 'hold', rate: 1.0 });

  // Hard seek at >= 80 ms
  assert.deepEqual(computeDriftAdjustment(80, false), { action: 'seek', rate: 1.0 });
  assert.deepEqual(computeDriftAdjustment(-120, true), { action: 'seek', rate: 1.0 });
  console.log('PASS: computeDriftAdjustment deadband, hysteresis, nudge & seek verified');
}

function testHarmonicCurve() {
  assert.equal(BASE_DELAY_SEC, 0.15);
  const curve = createHarmonicCurve(3.2, 1024);
  assert.equal(curve.length, 1024);

  let nonZero = 0;
  for (let i = 0; i < curve.length; i++) {
    assert.ok(Number.isFinite(curve[i]), 'Curve sample must be finite');
    assert.ok(curve[i] >= -1 && curve[i] <= 1, 'Curve sample must stay inside [-1, 1]');
    if (Math.abs(curve[i]) > 0.01) nonZero++;
  }
  assert.ok(nonZero > 900);
  // Check subtle asymmetry for 2nd-harmonic generation
  assert.notEqual(Math.abs(curve[100]), Math.abs(curve[1023 - 100]));
  console.log('PASS: createHarmonicCurve bounds and harmonic asymmetry verified');
}

function testDomIds() {
  const html = fs.readFileSync('public/index.html', 'utf8');
  const js = fs.readFileSync('public/js/app.js', 'utf8');
  const ids = [...js.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
  const missing = ids.filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, [], `Missing DOM IDs in index.html: ${missing.join(', ')}`);
  console.log(`PASS: All ${ids.length} DOM IDs referenced in app.js exist in index.html`);
}

testChunkRoundTrip();
testProceduralWavTrack();
testDriftAdjustment();
testHarmonicCurve();
testDomIds();
console.log('\nALL RELEASE 2 CHECKS PASSED');
