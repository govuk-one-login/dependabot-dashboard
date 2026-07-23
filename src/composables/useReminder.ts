import { ref, computed, onUnmounted } from 'vue'

export type ReminderMode = 'once' | 'repeat'

export function useReminder(
  notifyUser: (title: string, body: string) => void,
) {
  // ── State ───────────────────────────────────────────────────────────
  const durationMinutes = ref(5)
  const mode = ref<ReminderMode>('once')
  const running = ref(false)
  const remainingSeconds = ref(0)
  const fireCount = ref(0)

  let countdownInterval: ReturnType<typeof setInterval> | null = null

  // ── Computed ────────────────────────────────────────────────────────
  const displayTime = computed(() => {
    const mins = Math.floor(remainingSeconds.value / 60)
    const secs = remainingSeconds.value % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
  })

  const progress = computed(() => {
    const total = durationMinutes.value * 60
    if (total === 0) return 0
    return ((total - remainingSeconds.value) / total) * 100
  })

  // ── Actions ─────────────────────────────────────────────────────────
  function start() {
    if (durationMinutes.value <= 0) return
    remainingSeconds.value = durationMinutes.value * 60
    running.value = true
    fireCount.value = 0
    startCountdown()
  }

  function stop() {
    running.value = false
    clearCountdownInterval()
    remainingSeconds.value = 0
  }

  function startCountdown() {
    clearCountdownInterval()
    countdownInterval = setInterval(() => {
      if (remainingSeconds.value <= 0) {
        fireAlarm()
        return
      }
      remainingSeconds.value--
    }, 1000)
  }

  function fireAlarm() {
    fireCount.value++
    playAlarmSound()
    notifyUser(
      '⏰ Reminder!',
      mode.value === 'repeat'
        ? `Timer fired (×${fireCount.value}) — repeating every ${durationMinutes.value}min`
        : `Your ${durationMinutes.value}-minute reminder has fired.`,
    )

    if (mode.value === 'repeat') {
      // Restart for next cycle
      remainingSeconds.value = durationMinutes.value * 60
    } else {
      // Single-fire — stop
      stop()
    }
  }

  function clearCountdownInterval() {
    if (countdownInterval) {
      clearInterval(countdownInterval)
      countdownInterval = null
    }
  }

  function playAlarmSound() {
    try {
      const ctx = new AudioContext()
      const oscillator = ctx.createOscillator()
      const gain = ctx.createGain()
      oscillator.connect(gain)
      gain.connect(ctx.destination)
      oscillator.type = 'sine'
      gain.gain.setValueAtTime(0.4, ctx.currentTime)

      // Rising three-tone chime
      oscillator.frequency.setValueAtTime(523, ctx.currentTime)       // C5
      oscillator.frequency.setValueAtTime(659, ctx.currentTime + 0.2) // E5
      oscillator.frequency.setValueAtTime(784, ctx.currentTime + 0.4) // G5
      oscillator.frequency.setValueAtTime(1047, ctx.currentTime + 0.6) // C6

      oscillator.start(ctx.currentTime)
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.9)
      oscillator.stop(ctx.currentTime + 0.9)
    } catch {
      // Audio not available
    }
  }

  // ── Cleanup ─────────────────────────────────────────────────────────
  function cleanup() {
    clearCountdownInterval()
  }

  onUnmounted(cleanup)

  return {
    // State
    durationMinutes,
    mode,
    running,
    remainingSeconds,
    fireCount,

    // Computed
    displayTime,
    progress,

    // Actions
    start,
    stop,
    cleanup,
  }
}
