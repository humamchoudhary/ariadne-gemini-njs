/**
 * Advanced Voice Activity Detection (VAD) System
 * Uses Web Audio API for low-latency, CPU-based voice detection
 * No external dependencies - runs entirely in browser
 */

export interface VoiceActivityConfig {
  // Energy threshold for voice detection (0-1)
  energyThreshold: number;

  // Zero-crossing rate threshold
  zeroCrossingThreshold: number;

  // Minimum duration of speech to trigger (ms)
  minSpeechDuration: number;

  // Minimum silence duration to end speech (ms)
  minSilenceDuration: number;

  // FFT size for frequency analysis
  fftSize: number;

  // Frequency range for human voice (Hz)
  voiceFrequencyMin: number;
  voiceFrequencyMax: number;
}

export interface VoiceActivityEvent {
  type: "speech_start" | "speech_end" | "speech_active" | "noise";
  timestamp: number;
  energy: number;
  confidence: number;
  duration?: number;
}

const DEFAULT_CONFIG: VoiceActivityConfig = {
  energyThreshold: 0.02,
  zeroCrossingThreshold: 0.3,
  minSpeechDuration: 300,
  minSilenceDuration: 800,
  fftSize: 2048,
  voiceFrequencyMin: 85, // Lowest male voice
  voiceFrequencyMax: 3400, // Upper range of speech
};

export class VoiceActivityDetector {
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private animationFrame: number | null = null;

  private config: VoiceActivityConfig;
  private isSpeaking = false;
  private speechStartTime = 0;
  private lastSpeechTime = 0;
  private silenceStartTime = 0;

  private energyHistory: number[] = [];
  private energyHistorySize = 10;

  private onActivityCallback?: (event: VoiceActivityEvent) => void;

  constructor(config: Partial<VoiceActivityConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize VAD with audio stream
   */
  async init(
    stream: MediaStream,
    onActivity?: (event: VoiceActivityEvent) => void,
  ) {
    this.onActivityCallback = onActivity;

    // Create audio context
    this.audioContext = new (window.AudioContext ||
      (window as any).webkitAudioContext)({
      sampleRate: 16000, // Lower sample rate for speech
    });

    // Create analyser
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = this.config.fftSize;
    this.analyser.smoothingTimeConstant = 0.2;

    // Connect stream to analyser
    this.sourceNode = this.audioContext.createMediaStreamSource(stream);
    this.sourceNode.connect(this.analyser);

    // Start detection loop
    this.startDetection();

    console.log("✅ VAD initialized with config:", this.config);
  }

  /**
   * Main detection loop
   */
  private startDetection() {
    const detect = () => {
      if (!this.analyser) return;

      const now = Date.now();

      // Get audio data
      const bufferLength = this.analyser.frequencyBinCount;
      const frequencyData = new Uint8Array(bufferLength);
      const timeDomainData = new Uint8Array(bufferLength);

      this.analyser.getByteFrequencyData(frequencyData);
      this.analyser.getByteTimeDomainData(timeDomainData);

      // Calculate voice metrics
      const energy = this.calculateEnergy(timeDomainData);
      const voiceEnergy = this.calculateVoiceEnergy(frequencyData);
      const zeroCrossingRate = this.calculateZeroCrossingRate(timeDomainData);

      // Update energy history for adaptive threshold
      this.energyHistory.push(energy);
      if (this.energyHistory.length > this.energyHistorySize) {
        this.energyHistory.shift();
      }

      // Adaptive threshold based on recent history
      const avgEnergy =
        this.energyHistory.reduce((a, b) => a + b, 0) /
        this.energyHistory.length;
      const adaptiveThreshold = Math.max(
        this.config.energyThreshold,
        avgEnergy * 1.5,
      );

      // Voice confidence score (0-1)
      const energyScore = Math.min(1, energy / adaptiveThreshold);
      const voiceScore = Math.min(1, voiceEnergy / adaptiveThreshold);
      const zcrScore =
        zeroCrossingRate < this.config.zeroCrossingThreshold ? 1 : 0;

      const confidence = energyScore * 0.4 + voiceScore * 0.5 + zcrScore * 0.1;

      // Determine if voice is present
      const isVoicePresent = confidence > 0.6;

      // State machine for speech detection
      if (isVoicePresent) {
        this.lastSpeechTime = now;

        if (!this.isSpeaking) {
          // Potential speech start
          if (this.speechStartTime === 0) {
            this.speechStartTime = now;
          } else if (
            now - this.speechStartTime >=
            this.config.minSpeechDuration
          ) {
            // Confirmed speech start
            this.isSpeaking = true;
            this.silenceStartTime = 0;
            this.emitEvent({
              type: "speech_start",
              timestamp: now,
              energy,
              confidence,
            });
          }
        } else {
          // Ongoing speech
          this.emitEvent({
            type: "speech_active",
            timestamp: now,
            energy,
            confidence,
          });
        }
      } else {
        // No voice detected
        if (this.isSpeaking) {
          // Potential speech end
          if (this.silenceStartTime === 0) {
            this.silenceStartTime = now;
          } else if (
            now - this.silenceStartTime >=
            this.config.minSilenceDuration
          ) {
            // Confirmed speech end
            const duration =
              now - this.lastSpeechTime + this.config.minSilenceDuration;
            this.isSpeaking = false;
            this.speechStartTime = 0;
            this.silenceStartTime = 0;

            this.emitEvent({
              type: "speech_end",
              timestamp: now,
              energy,
              confidence,
              duration,
            });
          }
        } else {
          // Reset speech start if not enough duration
          if (
            this.speechStartTime !== 0 &&
            now - this.speechStartTime < this.config.minSpeechDuration
          ) {
            this.speechStartTime = 0;
          }

          // Emit noise events occasionally
          if (energy > this.config.energyThreshold * 0.5) {
            this.emitEvent({
              type: "noise",
              timestamp: now,
              energy,
              confidence,
            });
          }
        }
      }

      this.animationFrame = requestAnimationFrame(detect);
    };

    detect();
  }

  /**
   * Calculate overall energy from time domain data
   */
  private calculateEnergy(data: Uint8Array): number {
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const normalized = (data[i] - 128) / 128;
      sum += normalized * normalized;
    }
    return Math.sqrt(sum / data.length);
  }

  /**
   * Calculate energy in voice frequency range
   */
  private calculateVoiceEnergy(frequencyData: Uint8Array): number {
    if (!this.audioContext) return 0;

    const sampleRate = this.audioContext.sampleRate;
    const binSize = sampleRate / this.config.fftSize;

    const minBin = Math.floor(this.config.voiceFrequencyMin / binSize);
    const maxBin = Math.floor(this.config.voiceFrequencyMax / binSize);

    let sum = 0;
    let count = 0;

    for (let i = minBin; i < maxBin && i < frequencyData.length; i++) {
      sum += frequencyData[i] / 255;
      count++;
    }

    return count > 0 ? sum / count : 0;
  }

  /**
   * Calculate zero-crossing rate (helps distinguish speech from noise)
   */
  private calculateZeroCrossingRate(data: Uint8Array): number {
    let crossings = 0;
    for (let i = 1; i < data.length; i++) {
      if (
        (data[i] >= 128 && data[i - 1] < 128) ||
        (data[i] < 128 && data[i - 1] >= 128)
      ) {
        crossings++;
      }
    }
    return crossings / data.length;
  }

  /**
   * Emit activity event
   */
  private emitEvent(event: VoiceActivityEvent) {
    if (this.onActivityCallback) {
      this.onActivityCallback(event);
    }
  }

  /**
   * Get current speaking state
   */
  getState() {
    return {
      isSpeaking: this.isSpeaking,
      lastSpeechTime: this.lastSpeechTime,
      timeSinceLastSpeech: Date.now() - this.lastSpeechTime,
    };
  }

  /**
   * Update configuration on the fly
   */
  updateConfig(config: Partial<VoiceActivityConfig>) {
    this.config = { ...this.config, ...config };
    console.log("VAD config updated:", this.config);
  }

  /**
   * Stop detection and cleanup
   */
  stop() {
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }

    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    this.analyser = null;
    this.isSpeaking = false;
    this.speechStartTime = 0;
    this.lastSpeechTime = 0;
    this.silenceStartTime = 0;

    console.log("VAD stopped");
  }

  /**
   * Get analyser for visualization
   */
  getAnalyser(): AnalyserNode | null {
    return this.analyser;
  }
}
