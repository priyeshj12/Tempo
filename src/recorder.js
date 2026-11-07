// Records the stage canvas to a video file with MediaRecorder.

const TYPES = [
  ['video/mp4;codecs=avc1.640028', 'mp4'],
  ['video/mp4', 'mp4'],
  ['video/webm;codecs=vp9', 'webm'],
  ['video/webm;codecs=vp8', 'webm'],
  ['video/webm', 'webm'],
];

export function recordingSupported() {
  return typeof MediaRecorder !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream && !!pickType();
}

function pickType() {
  if (typeof MediaRecorder === 'undefined') return null;
  return TYPES.find(([t]) => MediaRecorder.isTypeSupported(t)) || null;
}

export class CanvasRecorder {
  constructor(canvas, fps = 60) {
    const [mimeType, ext] = pickType();
    this.ext = ext;
    this.mimeType = mimeType;
    this.stream = canvas.captureStream(fps);
    this.chunks = [];
    this.rec = new MediaRecorder(this.stream, { mimeType, videoBitsPerSecond: 16_000_000 });
    this.rec.ondataavailable = (e) => {
      if (e.data && e.data.size) this.chunks.push(e.data);
    };
  }

  start() {
    this.rec.start(250);
  }

  stop() {
    return new Promise((resolve) => {
      this.rec.onstop = () => {
        this.stream.getTracks().forEach((t) => t.stop());
        resolve(new Blob(this.chunks, { type: this.mimeType.split(';')[0] }));
      };
      this.rec.stop();
    });
  }
}
