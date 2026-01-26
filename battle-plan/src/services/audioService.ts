export class AudioFeedbackService {
    private audioContext: AudioContext | null = null;

    private init() {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
        }
    }

    private playTone(startFreq: number, endFreq: number, duration: number = 0.15) {
        this.init();
        if (!this.audioContext) return;

        const osc = this.audioContext.createOscillator();
        const gain = this.audioContext.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(startFreq, this.audioContext.currentTime);
        osc.frequency.exponentialRampToValueAtTime(endFreq, this.audioContext.currentTime + duration);

        gain.gain.setValueAtTime(0.1, this.audioContext.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + duration);

        osc.connect(gain);
        gain.connect(this.audioContext.destination);

        osc.start();
        osc.stop(this.audioContext.currentTime + duration);
    }

    playStart() {
        // Ascending tone: 440Hz to 880Hz
        this.playTone(440, 880, 0.1);
    }

    playStop() {
        // Descending tone: 880Hz to 440Hz
        this.playTone(880, 440, 0.1);
    }
}

export const audioFeedbackService = new AudioFeedbackService();
