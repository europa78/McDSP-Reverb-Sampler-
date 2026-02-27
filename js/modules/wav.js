import { clamp } from './math.js';

export function interleaveChannels(channels, length) {
  const out = new Float32Array(length * channels.length);
  let p = 0;
  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < channels.length; ch++) {
      out[p++] = channels[ch][i] || 0;
    }
  }
  return out;
}

export function encodeWavFromChannels(channelData, sampleRate) {
  const numChannels = channelData.length;
  const length = channelData[0]?.length || 0;
  const interleaved = interleaveChannels(channelData, length);
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = interleaved.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < interleaved.length; i++) {
    const sample = clamp(interleaved[i], -1, 1);
    const s16 = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
    view.setInt16(offset, s16, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}
