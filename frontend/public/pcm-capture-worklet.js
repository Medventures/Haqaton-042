/* Microphone PCM only. Nothing leaves the browser from this worklet. */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.chunkFrames = Math.round(sampleRate * 6)
    this.maxFrames = Math.round(sampleRate * 30 * 60)
    this.buffer = new Float32Array(this.chunkFrames)
    this.position = 0
    this.totalFrames = 0
    this.capturing = true
    this.levelFrames = 0
    this.port.onmessage = ({ data }) => {
      if (data.type === 'pause' || data.type === 'stop') {
        this.capturing = false
        this.flush()
      } else if (data.type === 'resume') {
        this.capturing = this.totalFrames < this.maxFrames
      }
      this.port.postMessage({ type: 'ack', id: data.id })
    }
  }

  flush() {
    if (!this.position) return
    const samples = this.buffer.slice(0, this.position)
    this.position = 0
    this.port.postMessage({ type: 'chunk', samples }, [samples.buffer])
  }

  process(inputs) {
    const channels = inputs[0]
    if (!this.capturing || !channels?.length) return true
    const frames = channels[0].length
    let sumSquares = 0
    for (let index = 0; index < frames; index += 1) {
      if (this.totalFrames >= this.maxFrames) {
        this.capturing = false
        this.flush()
        this.port.postMessage({ type: 'limit' })
        break
      }
      let value = 0
      for (const channel of channels) value += channel[index] || 0
      value /= channels.length
      this.buffer[this.position++] = value
      this.totalFrames += 1
      sumSquares += value * value
      if (this.position === this.chunkFrames) this.flush()
    }
    this.levelFrames += frames
    if (this.levelFrames >= sampleRate / 10) {
      this.levelFrames = 0
      this.port.postMessage({
        type: 'level',
        level: Math.sqrt(sumSquares / frames),
        seconds: this.totalFrames / sampleRate,
      })
    }
    // Outputs stay silent; the graph only keeps the processor scheduled.
    return true
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor)
