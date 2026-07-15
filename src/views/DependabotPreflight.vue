<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { usePreflight } from '@/composables/usePreflight'

const router = useRouter()
const {
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
  allOk,
  ghStepOk,
  agentStepOk,
  signingStepOk,
  teamsStepOk,
  completedSteps,
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
} = usePreflight()

onMounted(() => {
  restoreFromStorage()
  runChecks()
})

onUnmounted(cleanup)
</script>

<template>
  <div class="preflight-view">
    <!-- ── Progress bar ──────────────────────────────────────────── -->
    <div class="progress-bar">
      <div class="progress-bar__track">
        <div class="progress-bar__fill" :style="{ width: (completedSteps / 4 * 100) + '%' }"></div>
      </div>
      <div class="progress-bar__steps">
        <div v-for="(step, i) in [teamsStepOk, ghStepOk, agentStepOk, signingStepOk]" :key="i"
          class="progress-dot" :class="{ 'progress-dot--done': step }">
          <span class="progress-dot__icon">{{ step ? '✓' : i + 1 }}</span>
        </div>
      </div>
      <div class="progress-bar__labels">
        <span>Teams</span>
        <span>GitHub</span>
        <span>AI Agent</span>
        <span>Signing</span>
      </div>
    </div>

    <!-- ── Page header ───────────────────────────────────────────── -->
    <div class="page-intro">
      <h1 class="page-intro__title">Setup</h1>
      <p class="page-intro__sub">Verify tools and select your teams before continuing.</p>
      <button class="rerun-btn" :disabled="isChecking" @click="runChecks">
        <span v-if="isChecking" class="spinner spinner--sm"></span>
        <svg v-else aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M13.5 2.5a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-.75.75h-3.5a.75.75 0 0 1 0-1.5h1.72L10.03 4.53A5 5 0 1 0 13 8.75a.75.75 0 0 1 1.5 0A6.5 6.5 0 1 1 9.22 2.95l1.53 1.38V2.75a.75.75 0 0 1 .75-.75z"/>
        </svg>
        {{ isChecking ? 'Checking…' : 'Re-run checks' }}
      </button>
    </div>

    <!-- ── Card 1: Team Selection ────────────────────────────────── -->
    <div class="card" :class="{ 'card--ok': teamsStepOk }">
      <div class="card__header">
        <div class="card__header-left">
          <span class="card__step-num">1</span>
          <h2 class="card__title">Teams</h2>
        </div>
        <span v-if="teamsStepOk" class="badge badge--green">{{ selectedTeams.length }} selected</span>
        <span v-else-if="teamsLoading" class="badge badge--neutral"><span class="spinner spinner--xs"></span> Loading</span>
        <span v-else-if="checks.ghAuth.status !== 'ok'" class="badge badge--neutral">Waiting for auth</span>
        <span v-else class="badge badge--red">Select teams</span>
      </div>

      <div class="card__body" v-if="checks.ghAuth.status === 'ok'">
        <p class="card__desc">Choose which teams' repositories to monitor for Dependabot PRs.</p>

        <div v-if="teamsLoading" class="muted"><span class="spinner spinner--xs"></span> Loading teams…</div>
        <div v-else-if="teamsError" class="error-msg">{{ teamsError }}</div>
        <div v-else-if="availableTeams.length === 0" class="muted">
          No teams found. Ensure your token has <code>read:org</code> scope.
        </div>

        <template v-else>
          <div class="chips-header">
            <button class="link-btn" @click="selectAllTeams">Select all</button>
            <span class="chips-header__sep">·</span>
            <button class="link-btn" @click="deselectAllTeams">Clear</button>
          </div>
          <div class="chips">
            <button v-for="team in availableTeams" :key="team.name"
              class="chip" :class="{ 'chip--active': selectedTeams.includes(team.name) }"
              @click="toggleTeam(team.name)">
              <span class="chip__name">{{ team.name }}</span>
              <span class="chip__count">{{ team.repoCount }}</span>
              <span v-if="selectedTeams.includes(team.name)" class="chip__remove">×</span>
              <span v-else class="chip__add">+</span>
            </button>
          </div>
        </template>
      </div>

      <div class="card__body card__body--disabled" v-else>
        <p class="muted">Complete GitHub authentication to load teams.</p>
      </div>
    </div>

    <!-- ── Card 2: GitHub ────────────────────────────────────────── -->
    <div class="card" :class="{ 'card--ok': ghStepOk }">
      <div class="card__header">
        <div class="card__header-left">
          <span class="card__step-num">2</span>
          <h2 class="card__title">GitHub CLI</h2>
        </div>
        <span v-if="ghStepOk" class="badge badge--green">✓ Connected</span>
        <span v-else-if="checks.ghInstalled.status === 'checking' || checks.ghAuth.status === 'checking'" class="badge badge--neutral"><span class="spinner spinner--xs"></span> Checking</span>
        <span v-else class="badge badge--red">Action needed</span>
      </div>

      <div class="card__body" v-if="!ghStepOk || reAuthMode">
        <!-- gh installed -->
        <div class="check-item">
          <span class="check-item__icon" :class="'check-item__icon--' + checks.ghInstalled.status">
            <span v-if="checks.ghInstalled.status === 'ok'">✓</span>
            <span v-else-if="checks.ghInstalled.status === 'fail'">✗</span>
            <span v-else-if="checks.ghInstalled.status === 'checking'" class="spinner spinner--xs"></span>
            <span v-else>–</span>
          </span>
          <div class="check-item__text">
            <span class="check-item__label">CLI installed</span>
            <span v-if="checks.ghInstalled.detail" class="check-item__detail">{{ checks.ghInstalled.detail }}</span>
          </div>
          <div class="check-item__action">
            <button v-if="checks.ghInstalled.status === 'fail' && brewAvailable && installStatus === 'idle'"
              class="btn btn--sm btn--secondary" @click="installGh">Install via Homebrew</button>
            <span v-if="installStatus === 'running'" class="muted"><span class="spinner spinner--xs"></span> Installing…</span>
            <span v-if="installStatus === 'success'" class="badge badge--green">Installed ✓</span>
            <span v-if="installStatus === 'error'" class="badge badge--red">Failed</span>
          </div>
        </div>

        <!-- gh auth -->
        <div class="check-item">
          <span class="check-item__icon" :class="'check-item__icon--' + checks.ghAuth.status">
            <span v-if="checks.ghAuth.status === 'ok'">✓</span>
            <span v-else-if="checks.ghAuth.status === 'fail'">✗</span>
            <span v-else-if="checks.ghAuth.status === 'checking'" class="spinner spinner--xs"></span>
            <span v-else>–</span>
          </span>
          <div class="check-item__text">
            <span class="check-item__label">Authenticated</span>
            <span v-if="checks.ghAuth.detail" class="check-item__detail">{{ checks.ghAuth.detail }}</span>
          </div>
          <div class="check-item__action">
            <button v-if="checks.ghAuth.status === 'ok' && !reAuthMode"
              class="btn btn--sm btn--ghost" :disabled="logoutStatus === 'busy'" @click="startReAuth">
              Switch account
            </button>
          </div>
        </div>

        <!-- Token form -->
        <div v-if="(checks.ghAuth.status === 'fail' || reAuthMode) && checks.ghInstalled.status === 'ok'" class="token-form">
          <p class="token-form__hint">
            Enter a <a href="https://github.com/settings/tokens" target="_blank" rel="noopener noreferrer">GitHub Personal Access Token</a>
            with <code>repo</code>, <code>workflow</code>, and <code>read:org</code> scopes.
          </p>
          <div class="token-form__row">
            <div class="token-form__input-wrap">
              <input :type="tokenVisible ? 'text' : 'password'" v-model="tokenInput"
                class="token-form__input" placeholder="ghp_… or github_pat_…"
                autocomplete="off" spellcheck="false" :disabled="authStatus === 'submitting'"
                @keydown.enter="submitToken" />
              <button type="button" class="token-form__toggle"
                :aria-label="tokenVisible ? 'Hide token' : 'Show token'"
                @click="tokenVisible = !tokenVisible">{{ tokenVisible ? '🙈' : '👁' }}</button>
            </div>
            <button class="btn btn--primary btn--sm" :disabled="authStatus === 'submitting' || !tokenInput.trim()" @click="submitToken">
              {{ authStatus === 'submitting' ? 'Authenticating…' : 'Authenticate' }}
            </button>
          </div>
          <p v-if="authStatus === 'error'" class="error-msg">{{ authError }}</p>
        </div>
      </div>

      <!-- Collapsed summary when ok -->
      <div class="card__summary card__summary--between" v-if="ghStepOk && !reAuthMode">
        <span class="check-item__detail">{{ checks.ghAuth.detail }}</span>
        <button class="btn btn--sm btn--ghost" :disabled="logoutStatus === 'busy'" @click="startReAuth">
          {{ logoutStatus === 'busy' ? 'Signing out…' : 'Switch account' }}
        </button>
      </div>
    </div>

    <!-- ── Switch account overlay ────────────────────────────────── -->
    <transition name="fade">
      <div v-if="reAuthMode" class="overlay" @click.self="reAuthMode = false">
        <div class="overlay__panel">
          <div class="overlay__header">
            <h3 class="overlay__title">Switch GitHub account</h3>
            <button class="overlay__close" @click="reAuthMode = false" aria-label="Close">×</button>
          </div>
          <div class="overlay__body">
            <p class="token-form__hint">
              Enter a new <a href="https://github.com/settings/tokens" target="_blank" rel="noopener noreferrer">Personal Access Token</a>
              with <code>repo</code>, <code>workflow</code>, and <code>read:org</code> scopes.
            </p>
            <div class="token-form__row">
              <div class="token-form__input-wrap">
                <input :type="tokenVisible ? 'text' : 'password'" v-model="tokenInput"
                  class="token-form__input" placeholder="ghp_… or github_pat_…"
                  autocomplete="off" spellcheck="false" :disabled="authStatus === 'submitting'"
                  @keydown.enter="submitToken" />
                <button type="button" class="token-form__toggle"
                  :aria-label="tokenVisible ? 'Hide token' : 'Show token'"
                  @click="tokenVisible = !tokenVisible">{{ tokenVisible ? '🙈' : '👁' }}</button>
              </div>
              <button class="btn btn--primary btn--sm" :disabled="authStatus === 'submitting' || !tokenInput.trim()" @click="submitToken">
                {{ authStatus === 'submitting' ? 'Authenticating…' : 'Authenticate' }}
              </button>
            </div>
            <p v-if="authStatus === 'error'" class="error-msg">{{ authError }}</p>
          </div>
        </div>
      </div>
    </transition>

    <!-- ── Card 3: AI Agent ──────────────────────────────────────── -->
    <div class="card" :class="{ 'card--ok': agentStepOk }">
      <div class="card__header">
        <div class="card__header-left">
          <span class="card__step-num">3</span>
          <h2 class="card__title">AI Agent</h2>
        </div>
        <span v-if="agentStepOk" class="badge badge--green">✓ Ready</span>
        <span v-else-if="checks.kiroInstalled.status === 'checking' || checks.ollamaInstalled.status === 'checking'" class="badge badge--neutral"><span class="spinner spinner--xs"></span> Checking</span>
        <span v-else class="badge badge--red">Action needed</span>
      </div>

      <div class="card__body">
        <!-- Segmented toggle -->
        <div class="segmented-toggle">
          <button class="segmented-toggle__btn" :class="{ 'segmented-toggle__btn--active': agentChoice === 'kiro' }"
            @click="agentChoice = 'kiro'; runChecks()">Kiro CLI</button>
          <button class="segmented-toggle__btn" :class="{ 'segmented-toggle__btn--active': agentChoice === 'ollama' }"
            @click="agentChoice = 'ollama'; runChecks()">Ollama (local)</button>
        </div>

        <!-- Ollama model input -->
        <div v-if="agentChoice === 'ollama'" class="model-input">
          <label class="model-input__label" for="ollama-model">Model</label>
          <div class="model-input__row">
            <input id="ollama-model" class="model-input__field" type="text" v-model="ollamaModel"
              placeholder="e.g. codellama, llama3" spellcheck="false" autocomplete="off" />
            <button class="btn btn--sm btn--secondary" :disabled="isChecking" @click="runChecks">Check</button>
          </div>
        </div>

        <!-- Agent checks (only show if not yet ok) -->
        <div v-if="!agentStepOk" class="check-group">
          <template v-if="agentChoice === 'kiro'">
            <!-- sbx installed -->
            <div class="check-item">
              <span class="check-item__icon" :class="'check-item__icon--' + checks.sbxInstalled.status">
                <span v-if="checks.sbxInstalled.status === 'ok'">✓</span>
                <span v-else-if="checks.sbxInstalled.status === 'fail'">✗</span>
                <span v-else-if="checks.sbxInstalled.status === 'checking'" class="spinner spinner--xs"></span>
                <span v-else>–</span>
              </span>
              <div class="check-item__text">
                <span class="check-item__label">sbx installed</span>
                <span v-if="checks.sbxInstalled.detail" class="check-item__detail">{{ checks.sbxInstalled.detail }}</span>
              </div>
            </div>
            <p v-if="checks.sbxInstalled.status === 'fail'" class="help-text">
              <strong>sbx</strong> is required to run the Kiro docker sandbox. Install it via Homebrew:<br>
              <code>brew install docker/tap/sbx</code><br>
              Then re-run the checks above.
            </p>
            <div class="check-item">
              <span class="check-item__icon" :class="'check-item__icon--' + checks.kiroInstalled.status">
                <span v-if="checks.kiroInstalled.status === 'ok'">✓</span>
                <span v-else-if="checks.kiroInstalled.status === 'fail'">✗</span>
                <span v-else-if="checks.kiroInstalled.status === 'checking'" class="spinner spinner--xs"></span>
                <span v-else>–</span>
              </span>
              <div class="check-item__text">
                <span class="check-item__label">kiro-cli installed</span>
                <span v-if="checks.kiroInstalled.detail" class="check-item__detail">{{ checks.kiroInstalled.detail }}</span>
              </div>
              <div class="check-item__action">
                <button v-if="checks.kiroInstalled.status === 'fail' && kiroInstallStatus === 'idle'"
                  class="btn btn--sm btn--secondary" @click="installKiro">Install</button>
                <span v-if="kiroInstallStatus === 'running'" class="muted"><span class="spinner spinner--xs"></span></span>
                <span v-if="kiroInstallStatus === 'success'" class="badge badge--green">Installed ✓</span>
              </div>
            </div>
            <div class="check-item">
              <span class="check-item__icon" :class="'check-item__icon--' + checks.kiroAuth.status">
                <span v-if="checks.kiroAuth.status === 'ok'">✓</span>
                <span v-else-if="checks.kiroAuth.status === 'fail'">✗</span>
                <span v-else-if="checks.kiroAuth.status === 'checking'" class="spinner spinner--xs"></span>
                <span v-else>–</span>
              </span>
              <div class="check-item__text">
                <span class="check-item__label">Authenticated</span>
                <span v-if="checks.kiroAuth.detail" class="check-item__detail">{{ checks.kiroAuth.detail }}</span>
              </div>
            </div>
            <p v-if="checks.kiroAuth.status === 'fail' && checks.kiroInstalled.status === 'ok'" class="help-text">
              Run <code>kiro-cli</code> in your terminal to sign in via IAM Identity Centre.
              Use your organisation's SSO Start URL and <code>eu-west-2</code> as Region.
              <strong>Requires VPN.</strong>
            </p>
          </template>

          <template v-if="agentChoice === 'ollama'">
            <div class="check-item">
              <span class="check-item__icon" :class="'check-item__icon--' + checks.ollamaInstalled.status">
                <span v-if="checks.ollamaInstalled.status === 'ok'">✓</span>
                <span v-else-if="checks.ollamaInstalled.status === 'fail'">✗</span>
                <span v-else-if="checks.ollamaInstalled.status === 'checking'" class="spinner spinner--xs"></span>
                <span v-else>–</span>
              </span>
              <div class="check-item__text">
                <span class="check-item__label">Installed</span>
                <span v-if="checks.ollamaInstalled.detail" class="check-item__detail">{{ checks.ollamaInstalled.detail }}</span>
              </div>
            </div>
            <div class="check-item">
              <span class="check-item__icon" :class="'check-item__icon--' + checks.ollamaRunning.status">
                <span v-if="checks.ollamaRunning.status === 'ok'">✓</span>
                <span v-else-if="checks.ollamaRunning.status === 'fail'">✗</span>
                <span v-else-if="checks.ollamaRunning.status === 'checking'" class="spinner spinner--xs"></span>
                <span v-else>–</span>
              </span>
              <div class="check-item__text">
                <span class="check-item__label">Running &amp; model ready</span>
                <span v-if="checks.ollamaRunning.detail" class="check-item__detail">{{ checks.ollamaRunning.detail }}</span>
              </div>
            </div>
            <p v-if="checks.ollamaRunning.status === 'fail' && checks.ollamaInstalled.status === 'ok'" class="help-text">
              Run <code>ollama serve</code> then <code>ollama pull {{ ollamaModel || 'codellama' }}</code>
            </p>
          </template>
        </div>

        <!-- Collapsed summary when agent is ok -->
        <div v-if="agentStepOk" class="card__summary card__summary--inline">
          <span class="badge badge--subtle">{{ agentChoice === 'kiro' ? 'Kiro CLI' : `Ollama · ${ollamaModel}` }}</span>
          <span class="check-item__detail">{{ agentChoice === 'kiro' ? checks.kiroAuth.detail : checks.ollamaRunning.detail }}</span>
        </div>

        <!-- ai-sandbox repo notice (kiro only, non-blocking) -->
        <div v-if="agentChoice === 'kiro' && aiSandboxFound !== null" class="check-item check-item--notice">
          <span class="check-item__icon" :class="aiSandboxFound ? 'check-item__icon--ok' : 'check-item__icon--warn'">
            <span v-if="aiSandboxFound">✓</span>
            <span v-else>⚠</span>
          </span>
          <div class="check-item__text">
            <span class="check-item__label">ai-sandbox repo</span>
            <span class="check-item__detail">{{ aiSandboxFound ? 'Repository found locally' : 'Repository not found locally' }}</span>
          </div>
        </div>
        <div v-if="agentChoice === 'kiro' && aiSandboxFound === false" class="notice-box">
          The <strong>ai-sandbox</strong> repository is needed to configure and start the Kiro docker sandbox. Clone it with:
          <code class="notice-box__cmd">git clone git@github.com:govuk-one-login/ai-sandbox.git</code>
        </div>
      </div>
    </div>

    <!-- ── Card 4: Commit Signing ────────────────────────────────── -->
    <div class="card" :class="{ 'card--ok': signingStepOk }">
      <div class="card__header">
        <div class="card__header-left">
          <span class="card__step-num">4</span>
          <h2 class="card__title">Commit Signing</h2>
        </div>
        <span v-if="signingStepOk" class="badge badge--green">✓ Enabled</span>
        <span v-else-if="checks.gpgSigning.status === 'checking'" class="badge badge--neutral"><span class="spinner spinner--xs"></span> Checking</span>
        <span v-else class="badge badge--red">Action needed</span>
      </div>

      <div class="card__body" v-if="!signingStepOk">
        <div class="check-item">
          <span class="check-item__icon" :class="'check-item__icon--' + checks.gpgSigning.status">
            <span v-if="checks.gpgSigning.status === 'ok'">✓</span>
            <span v-else-if="checks.gpgSigning.status === 'fail'">✗</span>
            <span v-else-if="checks.gpgSigning.status === 'checking'" class="spinner spinner--xs"></span>
            <span v-else>–</span>
          </span>
          <div class="check-item__text">
            <span class="check-item__label">GPG signing</span>
            <span v-if="checks.gpgSigning.detail" class="check-item__detail">{{ checks.gpgSigning.detail }}</span>
          </div>
          <div class="check-item__action">
            <button v-if="checks.gpgSigning.status === 'fail' && (signingEnableStatus === 'idle' || signingEnableStatus === 'error')"
              class="btn btn--sm btn--secondary" :disabled="signingEnableStatus === 'running'" @click="enableSigning">
              Enable
            </button>
            <span v-if="signingEnableStatus === 'running'" class="muted"><span class="spinner spinner--xs"></span> Enabling…</span>
            <span v-if="signingEnableStatus === 'success'" class="badge badge--green">Enabled ✓</span>
          </div>
        </div>
        <p v-if="signingEnableStatus === 'error'" class="error-msg">{{ signingEnableError }}</p>
      </div>

      <div class="card__summary" v-if="signingStepOk">
        <span class="check-item__detail">{{ checks.gpgSigning.detail }}</span>
      </div>
    </div>

    <!-- ── Install logs (collapsible) ────────────────────────────── -->
    <details v-if="installLog.length" class="log-panel">
      <summary class="log-panel__summary">gh install log ({{ installLog.length }} lines)</summary>
      <pre class="log-panel__pre"><code>{{ installLog.join('\n') }}</code></pre>
    </details>
    <details v-if="kiroInstallLog.length" class="log-panel">
      <summary class="log-panel__summary">Kiro install log ({{ kiroInstallLog.length }} lines)</summary>
      <pre class="log-panel__pre"><code>{{ kiroInstallLog.join('\n') }}</code></pre>
    </details>

    <!-- ── Sticky continue bar ───────────────────────────────────── -->
    <transition name="slide-up">
      <div v-if="allOk" class="sticky-bar">
        <div class="sticky-bar__inner">
          <span class="sticky-bar__msg">All checks passed — ready to continue</span>
          <button class="btn btn--primary" @click="router.push('/dependabot-issues')">
            Continue →
          </button>
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
/* ── Layout ──────────────────────────────────────────────────────── */
.preflight-view {
  max-width: 680px;
  margin: 0 auto;
  padding: 32px 20px 120px;
}

/* ── Progress bar ────────────────────────────────────────────────── */
.progress-bar {
  margin-bottom: 32px;
}

.progress-bar__track {
  height: 4px;
  background: #e8e8e8;
  border-radius: 2px;
  overflow: hidden;
  margin-bottom: 12px;
}

.progress-bar__fill {
  height: 100%;
  background: linear-gradient(90deg, #00703c, #28a197);
  border-radius: 2px;
  transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}

.progress-bar__steps {
  display: flex;
  justify-content: space-between;
  padding: 0 8px;
  margin-bottom: 4px;
}

.progress-dot {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: #f3f2f1;
  border: 2px solid #b1b4b6;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.3s ease;
}

.progress-dot--done {
  background: #00703c;
  border-color: #00703c;
}

.progress-dot__icon {
  font-size: 0.75rem;
  font-weight: 700;
  color: #505a5f;
}

.progress-dot--done .progress-dot__icon {
  color: #fff;
}

.progress-bar__labels {
  display: flex;
  justify-content: space-between;
  padding: 0 0;
  font-size: 0.7rem;
  color: #505a5f;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-weight: 500;
}

.progress-bar__labels span {
  width: 28px;
  text-align: center;
  min-width: 50px;
}

/* ── Page intro ──────────────────────────────────────────────────── */
.page-intro {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 28px;
}

.page-intro__title {
  font-size: 1.6rem;
  font-weight: 800;
  color: #0b0c0c;
  margin: 0;
}

.page-intro__sub {
  font-size: 0.9rem;
  color: #505a5f;
  margin: 0;
  flex: 1;
}

.rerun-btn {
  all: unset;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.8rem;
  font-weight: 500;
  color: #505a5f;
  padding: 6px 12px;
  border-radius: 6px;
  border: 1px solid #d8d8d8;
  background: #fff;
  transition: all 0.15s ease;
}

.rerun-btn:hover:not(:disabled) {
  background: #f3f2f1;
  border-color: #b1b4b6;
  color: #0b0c0c;
}

.rerun-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

/* ── Cards ───────────────────────────────────────────────────────── */
.card {
  background: #fff;
  border: 1px solid #d8d8d8;
  border-radius: 10px;
  margin-bottom: 16px;
  overflow: hidden;
  transition: border-color 0.3s ease, box-shadow 0.3s ease;
}

.card--ok {
  border-color: #b7e7c4;
}

.card__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid #f3f2f1;
}

.card--ok .card__header {
  border-bottom-color: transparent;
}

.card__header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.card__step-num {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: #f3f2f1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.75rem;
  font-weight: 700;
  color: #505a5f;
  flex-shrink: 0;
}

.card--ok .card__step-num {
  background: #e8f8ee;
  color: #00703c;
}

.card__title {
  font-size: 1rem;
  font-weight: 700;
  color: #0b0c0c;
  margin: 0;
}

.card__body {
  padding: 16px 20px 20px;
}

.card__body--disabled {
  opacity: 0.5;
}

.card__summary {
  padding: 0 20px 16px;
  font-size: 0.85rem;
}

.card__summary--inline {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-top: 0;
}

.card__summary--between {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.card__desc {
  font-size: 0.85rem;
  color: #505a5f;
  margin: 0 0 14px;
}

/* ── Overlay / Modal ─────────────────────────────────────────────── */
.overlay {
  position: fixed;
  inset: 0;
  z-index: 500;
  background: rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}

.overlay__panel {
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.2);
  width: 100%;
  max-width: 480px;
  overflow: hidden;
}

.overlay__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid #f3f2f1;
}

.overlay__title {
  font-size: 1.05rem;
  font-weight: 700;
  color: #0b0c0c;
  margin: 0;
}

.overlay__close {
  all: unset;
  cursor: pointer;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.3rem;
  color: #505a5f;
  transition: background 0.15s;
}

.overlay__close:hover {
  background: #f3f2f1;
  color: #0b0c0c;
}

.overlay__body {
  padding: 20px;
}

/* Fade transition for overlay */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* ── Badges ──────────────────────────────────────────────────────── */
.badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 0.75rem;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 20px;
  white-space: nowrap;
}

.badge--green {
  background: #e8f8ee;
  color: #00703c;
}

.badge--red {
  background: #fce8e6;
  color: #d4351c;
}

.badge--neutral {
  background: #f3f2f1;
  color: #505a5f;
}

.badge--subtle {
  background: #f3f2f1;
  color: #0b0c0c;
  font-weight: 500;
}

/* ── Check items ─────────────────────────────────────────────────── */
.check-group {
  display: flex;
  flex-direction: column;
  gap: 0;
  margin-top: 12px;
}

.check-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid #f3f2f1;
}

.check-item:last-child {
  border-bottom: none;
}

.check-item__icon {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.75rem;
  font-weight: 700;
  flex-shrink: 0;
}

.check-item__icon--ok {
  background: #e8f8ee;
  color: #00703c;
}

.check-item__icon--fail {
  background: #fce8e6;
  color: #d4351c;
}

.check-item__icon--warn {
  background: #fff7e0;
  color: #b58800;
}

.check-item__icon--checking,
.check-item__icon--pending {
  background: #f3f2f1;
  color: #b1b4b6;
}

.check-item--notice {
  margin-top: 12px;
}

.notice-box {
  margin-top: 6px;
  padding: 10px 12px;
  background: #fff7e0;
  border-left: 3px solid #b58800;
  border-radius: 4px;
  font-size: 0.8125rem;
  color: #3d3d3d;
  line-height: 1.5;
}

.notice-box__cmd {
  display: block;
  margin-top: 6px;
  padding: 6px 8px;
  background: #1e1e1e;
  color: #d4d4d4;
  border-radius: 4px;
  font-size: 0.8rem;
  user-select: all;
}

.check-item__text {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.check-item__label {
  font-size: 0.88rem;
  font-weight: 600;
  color: #0b0c0c;
}

.check-item__detail {
  font-size: 0.8rem;
  color: #505a5f;
}

.check-item__action {
  flex-shrink: 0;
}

/* ── Buttons ─────────────────────────────────────────────────────── */
.btn {
  all: unset;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  border-radius: 6px;
  transition: all 0.15s ease;
  white-space: nowrap;
}

.btn--primary {
  background: #1d70b8;
  color: #fff;
  padding: 10px 20px;
  font-size: 0.88rem;
}

.btn--primary:hover {
  background: #003078;
}

.btn--secondary {
  background: #f3f2f1;
  color: #0b0c0c;
  border: 1px solid #b1b4b6;
  padding: 6px 14px;
  font-size: 0.8rem;
}

.btn--secondary:hover {
  background: #e8e8e8;
}

.btn--ghost {
  background: transparent;
  color: #1d70b8;
  padding: 6px 12px;
  font-size: 0.8rem;
}

.btn--ghost:hover {
  background: #f3f2f1;
}

.btn--sm {
  font-size: 0.78rem;
  padding: 5px 12px;
}

.btn:disabled {
  opacity: 0.45;
  cursor: default;
}

/* ── Segmented toggle ────────────────────────────────────────────── */
.segmented-toggle {
  display: inline-flex;
  background: #f3f2f1;
  border-radius: 8px;
  padding: 3px;
  gap: 2px;
  margin-bottom: 14px;
}

.segmented-toggle__btn {
  all: unset;
  cursor: pointer;
  padding: 8px 18px;
  font-size: 0.82rem;
  font-weight: 600;
  color: #505a5f;
  border-radius: 6px;
  transition: all 0.2s ease;
}

.segmented-toggle__btn--active {
  background: #fff;
  color: #0b0c0c;
  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
}

.segmented-toggle__btn:hover:not(.segmented-toggle__btn--active) {
  color: #0b0c0c;
}

/* ── Chips (team selection) ──────────────────────────────────────── */
.chips-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.chips-header__sep {
  color: #b1b4b6;
}

.link-btn {
  all: unset;
  cursor: pointer;
  font-size: 0.8rem;
  font-weight: 500;
  color: #1d70b8;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.link-btn:hover {
  color: #003078;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.chip {
  all: unset;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border-radius: 20px;
  font-size: 0.82rem;
  font-weight: 500;
  border: 1.5px solid #d8d8d8;
  color: #505a5f;
  background: #fff;
  transition: all 0.2s ease;
}

.chip:hover {
  border-color: #1d70b8;
  color: #1d70b8;
}

.chip--active {
  background: #e8f0fa;
  border-color: #1d70b8;
  color: #1d70b8;
}

.chip__name {
  font-weight: 600;
}

.chip__count {
  font-size: 0.72rem;
  background: rgba(0,0,0,0.06);
  padding: 1px 6px;
  border-radius: 10px;
}

.chip--active .chip__count {
  background: rgba(29,112,184,0.12);
}

.chip__remove,
.chip__add {
  font-size: 0.9rem;
  font-weight: 700;
  line-height: 1;
  margin-left: 2px;
}

.chip__remove {
  color: #1d70b8;
}

.chip__add {
  color: #b1b4b6;
}

.chip--active .chip__add {
  display: none;
}

.chip:not(.chip--active) .chip__remove {
  display: none;
}

/* ── Token form ──────────────────────────────────────────────────── */
.token-form {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid #f3f2f1;
}

.token-form__hint {
  font-size: 0.82rem;
  color: #505a5f;
  margin: 0 0 10px;
  line-height: 1.5;
}

.token-form__hint a {
  color: #1d70b8;
}

.token-form__hint code {
  background: #f3f2f1;
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 0.78rem;
}

.token-form__row {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  flex-wrap: wrap;
}

.token-form__input-wrap {
  position: relative;
  flex: 1;
  min-width: 200px;
}

.token-form__input {
  width: 100%;
  padding: 8px 36px 8px 12px;
  border: 1px solid #b1b4b6;
  border-radius: 6px;
  font-family: monospace;
  font-size: 0.82rem;
  box-sizing: border-box;
}

.token-form__input:focus {
  outline: 3px solid rgba(29,112,184,0.3);
  border-color: #1d70b8;
}

.token-form__toggle {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  cursor: pointer;
  font-size: 0.9rem;
  padding: 0;
  line-height: 1;
}

/* ── Model input ─────────────────────────────────────────────────── */
.model-input {
  margin-bottom: 12px;
}

.model-input__label {
  display: block;
  font-size: 0.8rem;
  font-weight: 500;
  color: #505a5f;
  margin-bottom: 4px;
}

.model-input__row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.model-input__field {
  padding: 7px 12px;
  border: 1px solid #b1b4b6;
  border-radius: 6px;
  font-size: 0.82rem;
  width: 180px;
}

.model-input__field:focus {
  outline: 3px solid rgba(29,112,184,0.3);
  border-color: #1d70b8;
}

/* ── Log panels ──────────────────────────────────────────────────── */
.log-panel {
  margin-bottom: 12px;
  border: 1px solid #d8d8d8;
  border-radius: 8px;
  overflow: hidden;
}

.log-panel__summary {
  cursor: pointer;
  padding: 10px 16px;
  font-size: 0.8rem;
  font-weight: 500;
  color: #505a5f;
  background: #f8f8f8;
}

.log-panel__pre {
  margin: 0;
  padding: 12px 16px;
  max-height: 220px;
  overflow-y: auto;
  font-size: 0.75rem;
  background: #1d1d1d;
  color: #e0e0e0;
  white-space: pre-wrap;
  word-break: break-all;
}

/* ── Sticky bottom bar ───────────────────────────────────────────── */
.sticky-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 100;
  background: #fff;
  border-top: 1px solid #d8d8d8;
  box-shadow: 0 -4px 20px rgba(0,0,0,0.08);
}

.sticky-bar__inner {
  max-width: 680px;
  margin: 0 auto;
  padding: 14px 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.sticky-bar__msg {
  font-size: 0.88rem;
  font-weight: 500;
  color: #00703c;
}

/* ── Transition ──────────────────────────────────────────────────── */
.slide-up-enter-active,
.slide-up-leave-active {
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s ease;
}

.slide-up-enter-from,
.slide-up-leave-to {
  transform: translateY(100%);
  opacity: 0;
}

/* ── Utilities ───────────────────────────────────────────────────── */
.spinner {
  display: inline-block;
  border: 2px solid #d8d8d8;
  border-top-color: #1d70b8;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

.spinner--sm {
  width: 14px;
  height: 14px;
}

.spinner--xs {
  width: 12px;
  height: 12px;
  border-width: 1.5px;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.muted {
  font-size: 0.82rem;
  color: #505a5f;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.error-msg {
  font-size: 0.82rem;
  color: #d4351c;
  margin: 8px 0 0;
}

.help-text {
  font-size: 0.8rem;
  color: #505a5f;
  line-height: 1.6;
  margin: 8px 0 0;
  padding: 10px 12px;
  background: #f8f8f8;
  border-radius: 6px;
}

.help-text code {
  background: #e8e8e8;
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 0.78rem;
}
</style>
