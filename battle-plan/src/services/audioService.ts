export class AudioFeedbackService {
    private audioContext: AudioContext | null = null;

    private async init() {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
        }
        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }
    }

    private async playTone(startFreq: number, endFreq: number, duration: number = 0.15) {
        await this.init();
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
        // Haptic feedback for mobile
        if ('vibrate' in navigator) {
            navigator.vibrate(50);
        }
    }

    playStop() {
        // Descending tone: 880Hz to 440Hz
        this.playTone(880, 440, 0.1);
        // Haptic feedback for mobile (two short pulses)
        if ('vibrate' in navigator) {
            navigator.vibrate([30, 30, 30]);
        }
    }
}

export const audioFeedbackService = new AudioFeedbackService();
