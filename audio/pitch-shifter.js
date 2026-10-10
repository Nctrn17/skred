class PitchShifter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{
      name: "semitones",
      defaultValue: -4,
      minValue: -12,
      maxValue: 12,
      automationRate: "k-rate"
    }];
  }

  constructor() {
    super();
    this.W = Math.round(sampleRate * 0.06); // fenêtre de 60 ms
    this.size = 1 << 15;
    this.mask = this.size - 1;
    this.buf = new Float32Array(this.size);
    this.w = 0;
    this.delay = 0;
  }

  read(delay) {
    const pos = this.w - 1 - delay;
    const i = Math.floor(pos);
    const frac = pos - i;
    const a = this.buf[i & this.mask];
    const b = this.buf[(i + 1) & this.mask];
    return a + (b - a) * frac;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];

    if (!input || input.length === 0) {
      for (const channel of output) channel.fill(0);
      return true;
    }

    const W = this.W;
    const ratio = Math.pow(2, parameters.semitones[0] / 12);
    const frames = output[0].length;

    for (let n = 0; n < frames; n++) {
      let mono = 0;
      for (let ch = 0; ch < input.length; ch++) mono += input[ch][n] || 0;
      mono /= input.length;

      this.buf[this.w & this.mask] = mono;
      this.w++;

      // Le point de lecture avance à la vitesse `ratio`
      this.delay += 1 - ratio;
      if (this.delay < 0) this.delay += W;
      if (this.delay >= W) this.delay -= W;

      // Deux têtes de lecture décalées d'une demi-fenêtre, en fondu croisé
      const d1 = this.delay;
      const d2 = (this.delay + W / 2) % W;
      const s = Math.sin(Math.PI * d1 / W);
      const w1 = s * s;
      const w2 = 1 - w1;

      const sample = w1 * this.read(d1) + w2 * this.read(d2);

      for (const channel of output) channel[n] = sample;
    }

    return true;
  }
}

registerProcessor("pitch-shifter", PitchShifter);