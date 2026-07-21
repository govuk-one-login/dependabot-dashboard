import { ref, computed, watch } from 'vue'

// ---- Types ----
export type CheckStatus = 'pending' | 'checking' | 'ok' | 'fail'
export type AgentChoice = 'kiro' | 'ollama'

export interface CheckState {
  status: CheckStatus
  detail: string
}

export interface PreflightResponse {
  gh: {
    installed: boolean
    version: string
    authenticated: boolean
    authUser: string
  }
  brew: {
    installed: boolean
  }
  sbx: {
    installed: boolean
  }
  kiro: {
    installed: boolean
    version: string
    authenticated: boolean
    authUser: string
    aiSandboxFound: boolean
  }
  ollama: {
    installed: boolean
    version: string
    running: boolean
    modelPulled: boolean
    model: string
  }
  gpgSigning: {
    enabled: boolean
    program: string
    keyConfigured: boolean
    keyValid: boolean
    pinentryOk: boolean
  }
}

export interface TeamInfo {
  name: string
  repoCount: number
}

export function usePreflight() {
  // ---- Agent selection ----
  const agentChoice = ref<AgentChoice>('kiro')
  const ollamaModel = ref('codellama')

  // Persist agent choice to localStorage so DependabotIssues can read it
  watch([agentChoice, ollamaModel], () => {
    localStorage.setItem(
      'dependabotAgentMode',
      JSON.stringify({ agent: agentChoice.value, model: ollamaModel.value }),
    )
  })

  // ---- State ----
  const checks = ref<{
    ghInstalled: CheckState
    ghAuth: CheckState
    sbxInstalled: CheckState
    kiroInstalled: CheckState
    kiroAuth: CheckState
    ollamaInstalled: CheckState
    ollamaRunning: CheckState
    gpgSigning: CheckState
  }>({
    ghInstalled:      { status: 'pending', detail: '' },
    ghAuth:           { status: 'pending', detail: '' },
    sbxInstalled:     { status: 'pending', detail: '' },
    kiroInstalled:    { status: 'pending', detail: '' },
    kiroAuth:         { status: 'pending', detail: '' },
    ollamaInstalled:  { status: 'pending', detail: '' },
    ollamaRunning:    { status: 'pending', detail: '' },
    gpgSigning:       { status: 'pending', detail: '' },
  })

  const isChecking = ref(false)
  const brewAvailable = ref(true)

  // gh install state
  const installLog = ref<string[]>([])
  const installStatus = ref<'idle' | 'running' | 'success' | 'error'>('idle')
  let installAbortController: AbortController | null = null

  // kiro install state
  const kiroInstallLog = ref<string[]>([])
  const kiroInstallStatus = ref<'idle' | 'running' | 'success' | 'error'>('idle')
  let kiroInstallAbortController: AbortController | null = null

  // GPG signing enable state
  const signingEnableStatus = ref<'idle' | 'running' | 'success' | 'error'>('idle')
  const signingEnableError = ref('')

  // Auth login via PAT
  const tokenInput = ref('')
  const tokenVisible = ref(false)
  const authStatus = ref<'idle' | 'submitting' | 'success' | 'error'>('idle')
  const authError = ref('')
  const reAuthMode = ref(false)
  const logoutStatus = ref<'idle' | 'busy'>('idle')

  // ai-sandbox repo check (non-blocking)
  const aiSandboxFound = ref<boolean | null>(null)

  // Team selection
  const availableTeams = ref<TeamInfo[]>([])
  const selectedTeams = ref<string[]>([])
  const teamsLoading = ref(false)
  const teamsError = ref<string | null>(null)

  // ---- Computed ----
  const allOk = computed(() =>
    ghStepOk.value &&
    agentStepOk.value &&
    signingStepOk.value &&
    teamsStepOk.value,
  )

  const ghStepOk = computed(() =>
    checks.value.ghInstalled.status === 'ok' && checks.value.ghAuth.status === 'ok',
  )

  const agentStepOk = computed(() => {
    if (agentChoice.value === 'kiro') {
      return checks.value.sbxInstalled.status === 'ok' &&
        checks.value.kiroInstalled.status === 'ok' &&
        checks.value.kiroAuth.status === 'ok'
    }
    return checks.value.ollamaInstalled.status === 'ok' && checks.value.ollamaRunning.status === 'ok'
  })

  const signingStepOk = computed(() => checks.value.gpgSigning.status === 'ok')
  const teamsStepOk = computed(() => selectedTeams.value.length > 0)

  const completedSteps = computed(() =>
    [ghStepOk.value, agentStepOk.value, signingStepOk.value, teamsStepOk.value].filter(Boolean).length,
  )

  // ---- Functions ----
  async function runChecks() {
    isChecking.value = true
    checks.value.ghInstalled      = { status: 'checking', detail: '' }
    checks.value.ghAuth           = { status: 'checking', detail: '' }
    checks.value.sbxInstalled     = agentChoice.value === 'kiro' ? { status: 'checking', detail: '' } : { status: 'pending', detail: '' }
    checks.value.kiroInstalled    = agentChoice.value === 'kiro' ? { status: 'checking', detail: '' } : { status: 'pending', detail: '' }
    if (agentChoice.value === 'kiro') aiSandboxFound.value = null
    checks.value.kiroAuth         = agentChoice.value === 'kiro' ? { status: 'checking', detail: '' } : { status: 'pending', detail: '' }
    checks.value.ollamaInstalled  = agentChoice.value === 'ollama' ? { status: 'checking', detail: '' } : { status: 'pending', detail: '' }
    checks.value.ollamaRunning    = agentChoice.value === 'ollama' ? { status: 'checking', detail: '' } : { status: 'pending', detail: '' }
    checks.value.gpgSigning       = { status: 'checking', detail: '' }

    try {
      const params = new URLSearchParams({ agent: agentChoice.value })
      if (agentChoice.value === 'ollama' && ollamaModel.value.trim()) {
        params.set('model', ollamaModel.value.trim())
      }
      const res = await fetch(`/api/dependabot-preflight?${params.toString()}`)
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      const data: PreflightResponse = await res.json()

      brewAvailable.value = data.brew?.installed ?? true

      checks.value.ghInstalled = data.gh.installed
        ? { status: 'ok',   detail: data.gh.version }
        : { status: 'fail', detail: 'gh CLI not found on PATH' }

      if (data.gh.installed) {
        checks.value.ghAuth = data.gh.authenticated
          ? { status: 'ok',   detail: data.gh.authUser ? `Signed in as ${data.gh.authUser}` : 'Authenticated' }
          : { status: 'fail', detail: 'Not authenticated — run gh auth login' }

        // Fetch teams once we know gh is authenticated
        if (data.gh.authenticated) {
          fetchTeams()
        }
      } else {
        checks.value.ghAuth = { status: 'pending', detail: 'Waiting for gh installation' }
      }

      if (agentChoice.value === 'kiro') {
        checks.value.sbxInstalled = data.sbx?.installed
          ? { status: 'ok', detail: 'sbx found on PATH' }
          : { status: 'fail', detail: 'sbx not found — install it to run the Kiro sandbox' }
        checks.value.kiroInstalled = data.kiro.installed
          ? { status: 'ok',   detail: data.kiro.version }
          : { status: 'fail', detail: 'kiro-cli not found in sandbox — ensure di-kiro-ai-sandbox is running' }
        checks.value.kiroAuth = data.kiro.authenticated
          ? { status: 'ok',   detail: data.kiro.authUser ? `Signed in as ${data.kiro.authUser}` : 'Authenticated' }
          : { status: 'fail', detail: data.kiro.installed ? 'Follow the authentication instructions contained in the README file in the ai-sandbox repo' : 'kiro-cli not available in sandbox' }
        aiSandboxFound.value = data.kiro.aiSandboxFound ?? false
      } else {
        checks.value.sbxInstalled  = { status: 'pending', detail: '' }
        checks.value.kiroInstalled = { status: 'pending', detail: '' }
        checks.value.kiroAuth      = { status: 'pending', detail: '' }
      }

      if (agentChoice.value === 'ollama') {
        checks.value.ollamaInstalled = data.ollama.installed
          ? { status: 'ok',   detail: data.ollama.version }
          : { status: 'fail', detail: 'ollama not found on PATH — install from https://ollama.com' }
        if (data.ollama.installed) {
          const modelName = ollamaModel.value.trim() || 'codellama'
          if (!data.ollama.running) {
            checks.value.ollamaRunning = { status: 'fail', detail: 'Ollama daemon not running — run: ollama serve' }
          } else if (!data.ollama.modelPulled) {
            checks.value.ollamaRunning = { status: 'fail', detail: `Model "${modelName}" not pulled — run: ollama pull ${modelName}` }
          } else {
            checks.value.ollamaRunning = { status: 'ok', detail: `Running · model "${modelName}" available` }
          }
        } else {
          checks.value.ollamaRunning = { status: 'pending', detail: 'Install Ollama first' }
        }
      } else {
        checks.value.ollamaInstalled = { status: 'pending', detail: '' }
        checks.value.ollamaRunning   = { status: 'pending', detail: '' }
      }

      const gpg = data.gpgSigning
      if (gpg.enabled && gpg.keyValid && gpg.pinentryOk) {
        const prog = gpg.program ? ` · ${gpg.program}` : ''
        checks.value.gpgSigning = { status: 'ok', detail: `Signing key configured${prog}` }
      } else if (gpg.enabled && gpg.keyValid && !gpg.pinentryOk) {
        checks.value.gpgSigning = { status: 'fail', detail: 'pinentry-mac not configured — commits will fail without a TTY (click Enable to fix)' }
      } else if (!gpg.keyValid && gpg.keyConfigured) {
        checks.value.gpgSigning = { status: 'fail', detail: 'Signing key not found in GPG keyring' }
      } else if (!gpg.enabled) {
        checks.value.gpgSigning = { status: 'fail', detail: gpg.keyConfigured ? 'commit.gpgsign is off (key available)' : 'commit.gpgsign is off — no signing key configured' }
      } else {
        checks.value.gpgSigning = { status: 'fail', detail: 'No GPG signing key configured' }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      checks.value.ghInstalled      = { status: 'fail', detail: msg }
      checks.value.ghAuth           = { status: 'fail', detail: msg }
      checks.value.sbxInstalled     = { status: 'fail', detail: msg }
      checks.value.kiroInstalled    = { status: 'fail', detail: msg }
      checks.value.kiroAuth         = { status: 'fail', detail: msg }
      checks.value.ollamaInstalled  = { status: 'fail', detail: msg }
      checks.value.ollamaRunning    = { status: 'fail', detail: msg }
      checks.value.gpgSigning       = { status: 'fail', detail: msg }
    } finally {
      isChecking.value = false
    }
  }

  // ---- Shared POST-SSE stream reader ----
  async function runPostSseInstall(
    url: string,
    log: typeof installLog,
    status: typeof installStatus,
    abortControllerRef: { value: AbortController | null },
  ) {
    abortControllerRef.value?.abort()
    const controller = new AbortController()
    abortControllerRef.value = controller

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      })

      if (!response.ok || !response.body) {
        status.value = 'error'
        log.value.push(`[Server error: ${response.status}]`)
        return
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const parts = buffer.split('\n\n')
        buffer = parts.pop() ?? ''

        for (const block of parts) {
          let eventType = 'message'
          let dataLine = ''
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) eventType = line.slice(7).trim()
            else if (line.startsWith('data: ')) dataLine = line.slice(6).trim()
          }
          if (!dataLine) continue
          const payload: string = JSON.parse(dataLine)
          if (eventType === 'log') {
            payload.split('\n').forEach((l) => { if (l.trim()) log.value.push(l) })
          } else if (eventType === 'done') {
            abortControllerRef.value = null
            status.value = payload === 'success' ? 'success' : 'error'
            if (payload === 'success') await runChecks()
            return
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return
      status.value = 'error'
      log.value.push('[Connection lost — the install may still be running. Re-run checks once complete.]')
    } finally {
      if (abortControllerRef.value === controller) abortControllerRef.value = null
    }
  }

  // ---- Install gh ----
  function installGh() {
    installLog.value = []
    installStatus.value = 'running'
    const ref = { get value() { return installAbortController }, set value(v) { installAbortController = v } }
    runPostSseInstall('/api/dependabot-install-gh', installLog, installStatus, ref)
  }

  // ---- Install kiro-cli ----
  function installKiro() {
    kiroInstallLog.value = []
    kiroInstallStatus.value = 'running'
    const ref = { get value() { return kiroInstallAbortController }, set value(v) { kiroInstallAbortController = v } }
    runPostSseInstall('/api/dependabot-install-kiro', kiroInstallLog, kiroInstallStatus, ref)
  }

  // ---- Enable GPG commit signing ----
  async function enableSigning() {
    signingEnableStatus.value = 'running'
    signingEnableError.value = ''
    try {
      const res = await fetch('/api/dependabot-enable-signing', { method: 'POST' })
      const data = await res.json()
      if (data.success) {
        signingEnableStatus.value = 'success'
        await runChecks()
      } else {
        signingEnableStatus.value = 'error'
        signingEnableError.value = data.message ?? 'Failed to enable signing'
      }
    } catch (err: unknown) {
      signingEnableStatus.value = 'error'
      signingEnableError.value = err instanceof Error ? err.message : 'Unknown error'
    }
  }

  // ---- Team selection ----
  async function fetchTeams() {
    teamsLoading.value = true
    teamsError.value = null
    try {
      const res = await fetch('/api/dependabot-teams')
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      const data = await res.json() as { teams: TeamInfo[] }
      availableTeams.value = data.teams

      if (selectedTeams.value.length === 0) {
        selectedTeams.value = data.teams.map((t) => t.name)
      } else {
        const validNames = new Set(data.teams.map((t) => t.name))
        selectedTeams.value = selectedTeams.value.filter((t) => validNames.has(t))
      }
    } catch (err: unknown) {
      teamsError.value = err instanceof Error ? err.message : 'Unknown error'
    } finally {
      teamsLoading.value = false
    }
  }

  function toggleTeam(teamName: string) {
    const idx = selectedTeams.value.indexOf(teamName)
    if (idx >= 0) {
      selectedTeams.value.splice(idx, 1)
    } else {
      selectedTeams.value.push(teamName)
    }
    persistSelectedTeams()
  }

  function selectAllTeams() {
    selectedTeams.value = availableTeams.value.map((t) => t.name)
    persistSelectedTeams()
  }

  function deselectAllTeams() {
    selectedTeams.value = []
    persistSelectedTeams()
  }

  function persistSelectedTeams() {
    localStorage.setItem('dependabotSelectedTeams', JSON.stringify(selectedTeams.value))
  }

  watch(selectedTeams, persistSelectedTeams, { deep: true })

  // ---- Auth ----
  async function submitToken() {
    if (!tokenInput.value.trim()) return
    authStatus.value = 'submitting'
    authError.value = ''

    try {
      const res = await fetch('/api/dependabot-gh-auth-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: tokenInput.value.trim() }),
      })
      const data = await res.json()
      if (data.success) {
        authStatus.value = 'success'
        tokenInput.value = ''
        reAuthMode.value = false
        await runChecks()
      } else {
        authStatus.value = 'error'
        authError.value = data.message ?? 'Authentication failed'
      }
    } catch (err: unknown) {
      authStatus.value = 'error'
      authError.value = err instanceof Error ? err.message : 'Unknown error'
    }
  }

  async function startReAuth() {
    logoutStatus.value = 'busy'
    try {
      await fetch('/api/dependabot-gh-auth-logout', { method: 'POST' })
    } finally {
      logoutStatus.value = 'idle'
    }
    tokenInput.value = ''
    tokenVisible.value = false
    authStatus.value = 'idle'
    authError.value = ''
    reAuthMode.value = true
    checks.value.ghAuth = { status: 'fail', detail: 'Logged out — enter a new token below' }
  }

  // ---- Cleanup ----
  function cleanup() {
    installAbortController?.abort()
    kiroInstallAbortController?.abort()
  }

  // ---- Restore from localStorage ----
  function restoreFromStorage() {
    try {
      const stored = localStorage.getItem('dependabotAgentMode')
      if (stored) {
        const parsed = JSON.parse(stored) as { agent?: string; model?: string }
        if (parsed.agent === 'kiro' || parsed.agent === 'ollama') {
          agentChoice.value = parsed.agent
        }
        if (parsed.model) ollamaModel.value = parsed.model
      }
    } catch {
      // ignore
    }

    try {
      const storedTeams = localStorage.getItem('dependabotSelectedTeams')
      if (storedTeams) {
        selectedTeams.value = JSON.parse(storedTeams) as string[]
      }
    } catch {
      // ignore
    }
  }

  return {
    // State
    agentChoice,
    ollamaModel,
    checks,
    isChecking,
    brewAvailable,
    installLog,
    installStatus,
    kiroInstallLog,
    kiroInstallStatus,
    signingEnableStatus,
    signingEnableError,
    tokenInput,
    tokenVisible,
    authStatus,
    authError,
    reAuthMode,
    logoutStatus,
    availableTeams,
    selectedTeams,
    teamsLoading,
    teamsError,
    aiSandboxFound,

    // Computed
    allOk,
    ghStepOk,
    agentStepOk,
    signingStepOk,
    teamsStepOk,
    completedSteps,

    // Functions
    runChecks,
    installGh,
    installKiro,
    enableSigning,
    fetchTeams,
    toggleTeam,
    selectAllTeams,
    deselectAllTeams,
    persistSelectedTeams,
    submitToken,
    startReAuth,
    cleanup,
    restoreFromStorage,
  }
}
