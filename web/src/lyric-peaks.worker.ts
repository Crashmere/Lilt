export {};

self.onmessage = (event: MessageEvent<{ channels: Float32Array[] }>) => {
  const peaks = new Float32Array(4096);
  const length = event.data.channels[0]?.length || 0;
  for (let bin = 0; bin < peaks.length; bin++) {
    const start = Math.floor(bin * length / peaks.length), end = Math.floor((bin + 1) * length / peaks.length);
    let peak = 0;
    for (const channel of event.data.channels) {
      for (let index = start; index < end; index++) peak = Math.max(peak, Math.abs(channel[index]));
    }
    peaks[bin] = Math.min(1, peak);
  }
  self.postMessage(peaks, { transfer: [peaks.buffer] });
};
