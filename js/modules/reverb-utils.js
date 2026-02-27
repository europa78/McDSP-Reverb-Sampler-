export function createImpulseResponse(audioContext, { seconds, diffusion }) {
  const sr = audioContext.sampleRate;
  const length = Math.max(1, Math.floor(sr * seconds));
  const ir = audioContext.createBuffer(2, length, sr);
  const diffExp = 0.8 + diffusion * 3.2;

  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const t = i / length;
      const env = Math.pow(1 - t, diffExp);
      data[i] = (Math.random() * 2 - 1) * env;
    }
  }
  return ir;
}
