// AudioWorkletProcessor that collects 960-sample (20 ms @ 48 kHz) stereo frames for live Cast encoding

const FRAME_SAMPLES = 960;

class PcmCaptureWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.leftBuf = new Float32Array(FRAME_SAMPLES);
    this.rightBuf = new Float32Array(FRAME_SAMPLES);
    this.writeIndex = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) {
      return true;
    }

    const inLeft = input[0];
    if (!inLeft || inLeft.length === 0) {
      return true;
    }
    const inRight = input.length > 1 && input[1] ? input[1] : inLeft;

    let readPos = 0;
    const total = inLeft.length;

    while (readPos < total) {
      const space = FRAME_SAMPLES - this.writeIndex;
      const toCopy = Math.min(space, total - readPos);

      this.leftBuf.set(inLeft.subarray(readPos, readPos + toCopy), this.writeIndex);
      this.rightBuf.set(inRight.subarray(readPos, readPos + toCopy), this.writeIndex);

      this.writeIndex += toCopy;
      readPos += toCopy;

      if (this.writeIndex === FRAME_SAMPLES) {
        const outLeft = this.leftBuf;
        const outRight = this.rightBuf;
        this.leftBuf = new Float32Array(FRAME_SAMPLES);
        this.rightBuf = new Float32Array(FRAME_SAMPLES);
        this.writeIndex = 0;

        this.port.postMessage(
          {
            left: outLeft,
            right: outRight,
            frameCount: FRAME_SAMPLES,
            sampleRate,
          },
          [outLeft.buffer, outRight.buffer]
        );
      }
    }

    return true;
  }
}

registerProcessor('pcm-capture-worklet', PcmCaptureWorklet);
