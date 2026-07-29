<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import TreeView from '@/components/dependabot/TreeView.vue'
import PrWorkArea from '@/components/dependabot/PrWorkArea.vue'
import { useDependabotPrs } from '@/composables/useDependabotPrs'
import { useReminder } from '@/composables/useReminder'
import type { AgentConfig } from '@/composables/useDependabotPrs'

// ── Tab attention helper ────────────────────────────────────────────
const originalTitle = document.title
let titleFlashInterval: ReturnType<typeof setInterval> | null = null

function stopTitleFlash() {
  if (titleFlashInterval) {
    clearInterval(titleFlashInterval)
    titleFlashInterval = null
  }
}

function notifyUser(title: string, body: string) {
  document.title = title
  if (document.visibilityState === 'hidden') {
    let toggle = false
    stopTitleFlash()
    titleFlashInterval = setInterval(() => {
      document.title = toggle ? title : originalTitle
      toggle = !toggle
    }, 1000)
    if ('Notification' in globalThis) {
      if (Notification.permission === 'granted') {
        new Notification('DPT Admin Dashboard', { body, icon: '/assets/images/govuk-icon-180.png' })
      } else if (Notification.permission !== 'denied') {
        Notification.requestPermission().then((perm) => {
          if (perm === 'granted') new Notification('DPT Admin Dashboard', { body, icon: '/assets/images/govuk-icon-180.png' })
        })
      }
    }
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') stopTitleFlash()
})

// ── Close open menus when clicking outside ──────────────────────────
function closeOpenMenus(e: MouseEvent) {
  const target = e.target as Element
  document.querySelectorAll<HTMLDetailsElement>('details[open]').forEach((el) => {
    if (!el.contains(target)) {
      el.removeAttribute('open')
    }
  })
}
document.addEventListener('click', closeOpenMenus)

// ── Composable ──────────────────────────────────────────────────────
const {
  agentConfig,
  categories,
  results,
  loading,
  fetchError,
  lastFetched,
  expandedCategories,
  expandedRepos,
  selectedPrId,
  actionStates,
  allPrs,
  totalPrCount,
  failingCount,
  passingCount,
  pendingCount,
  outdatedCount,
  readyToMergeCount,
  awaitingReviewCount,
  secondaryReviewCount,
  reposWithPrsCount,
  repoErrorCount,
  treeCategories,
  selectedRepo,
  selectedPrNumber,
  selectedPr,
  selectedState,
  toggleCategory,
  toggleRepo,
  selectPr,
  fetchPrs,
  approvePr,
  mergePr,
  updateBranch,
  stopFix,
  planWithAi,
  executePlan,
  replanWithComment,
  discardPlan,
  fixWithAi,
  applyKnownFix,
  pushFix,
  discardFix,
  copySlackMessage,
  recreatePr,
  deleteBranch,
  bulkUpdating,
  bulkUpdateSummary,
  bulkUpdateBranches,
  branchMonitoring,
  branchMonitorProgress,
  stateFor,
  activeEventSources,
  cleanup,
} = useDependabotPrs(notifyUser)

// ── Reminder timer ──────────────────────────────────────────────────
const {
  durationMinutes: reminderMinutes,
  mode: reminderMode,
  running: reminderRunning,
  displayTime: reminderDisplay,
  progress: reminderProgress,
  start: startReminder,
  stop: stopReminder,
} = useReminder(notifyUser)

onMounted(() => {
  // Read agent choice set by DependabotPreflight
  try {
    const stored = localStorage.getItem('dependabotAgentMode')
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<AgentConfig>
      if (parsed.agent === 'kiro' || parsed.agent === 'ollama') {
        agentConfig.value = {
          agent: parsed.agent,
          model: parsed.model ?? 'codellama',
        }
      }
    }
  } catch {
    // ignore — default to kiro
  }
  fetchPrs()
})

onUnmounted(() => {
  stopTitleFlash()
  document.removeEventListener('click', closeOpenMenus)
  cleanup()
})
</script>

<template>
  <div class="dependabot-view">
    <!-- ── Header ────────────────────────────────────────────────── -->
    <div class="page-header">
      <div class="page-header__left">
        <router-link class="page-header__back" to="/">← Setup</router-link>
        <h1 class="page-header__title">Dependabot</h1>
      </div>
      <div class="page-header__right">
        <span v-if="lastFetched && !loading" class="page-header__time">Last refreshed: {{ lastFetched.toLocaleTimeString() }}</span>

        <!-- Reminder timer -->
        <details class="reminder-dropdown">
          <summary class="reminder-dropdown__trigger" :class="{ 'reminder-dropdown__trigger--active': reminderRunning }">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><path d="M5 3L2 6"/><path d="M22 6l-3-3"/>
            </svg>
            <span v-if="reminderRunning" class="reminder-dropdown__countdown">{{ reminderDisplay }}</span>
            <span v-else>Timer</span>
          </summary>
          <div class="reminder-dropdown__menu">
            <template v-if="!reminderRunning">
              <div class="reminder-dropdown__field">
                <label class="reminder-dropdown__label" for="reminder-mins">Minutes</label>
                <input
                  id="reminder-mins"
                  v-model.number="reminderMinutes"
                  type="number"
                  min="1"
                  max="120"
                  class="reminder-dropdown__input"
                />
              </div>
              <div class="reminder-dropdown__field">
                <label class="reminder-dropdown__label">Mode</label>
                <div class="reminder-dropdown__toggle">
                  <button
                    class="reminder-dropdown__mode-btn"
                    :class="{ 'reminder-dropdown__mode-btn--active': reminderMode === 'once' }"
                    @click="reminderMode = 'once'"
                  >Once</button>
                  <button
                    class="reminder-dropdown__mode-btn"
                    :class="{ 'reminder-dropdown__mode-btn--active': reminderMode === 'repeat' }"
                    @click="reminderMode = 'repeat'"
                  >Repeat</button>
                </div>
              </div>
              <button class="reminder-dropdown__start" @click="startReminder">
                Start timer
              </button>
            </template>
            <template v-else>
              <div class="reminder-dropdown__status">
                <div class="reminder-dropdown__progress-bar">
                  <div class="reminder-dropdown__progress-fill" :style="{ width: reminderProgress + '%' }"></div>
                </div>
                <div class="reminder-dropdown__status-text">
                  {{ reminderDisplay }} remaining
                  <span class="reminder-dropdown__mode-badge">{{ reminderMode }}</span>
                </div>
              </div>
              <button class="reminder-dropdown__stop" @click="stopReminder">
                Stop timer
              </button>
            </template>
          </div>
        </details>

        <span v-if="branchMonitorProgress" class="page-header__monitor-badge">{{ branchMonitorProgress }}</span>
        <details class="update-dropdown">
          <summary class="update-dropdown__trigger" :class="{ 'update-dropdown__trigger--active': branchMonitoring }">
            <span v-if="bulkUpdating" class="spinner spinner--sm"></span>
            Update outdated{{ outdatedCount ? ` (${outdatedCount})` : '' }}
            <svg class="update-dropdown__chevron" width="10" height="6" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </summary>
          <div class="update-dropdown__menu">
            <button
              class="update-dropdown__item update-dropdown__item--action"
              :disabled="bulkUpdating || outdatedCount === 0"
              @click="bulkUpdateBranches"
            >
              <span v-if="bulkUpdating" class="spinner spinner--sm"></span>
              Rebase all outdated branches
            </button>
            <div class="update-dropdown__divider"></div>
            <label class="update-dropdown__item update-dropdown__item--check">
              <input
                v-model="branchMonitoring"
                type="checkbox"
                class="update-dropdown__checkbox"
                :disabled="!branchMonitoring && outdatedCount === 0"
              />
              <span class="update-dropdown__check-label">
                Monitor branches
                <span class="update-dropdown__check-desc">Alert when all are up to date (polls every 30s)</span>
              </span>
            </label>
          </div>
        </details>
      </div>
    </div>

    <!-- ── Toast notifications ───────────────────────────────────── -->
    <transition name="toast">
      <div v-if="bulkUpdateSummary" class="toast" :class="bulkUpdateSummary.failed ? 'toast--warn' : 'toast--ok'">
        <span v-if="bulkUpdateSummary.failed === 0">
          ✓ Rebase triggered on {{ bulkUpdateSummary.succeeded }} PR{{ bulkUpdateSummary.succeeded !== 1 ? 's' : '' }}
        </span>
        <span v-else>
          {{ bulkUpdateSummary.succeeded }} rebased; {{ bulkUpdateSummary.failed }} failed
        </span>
      </div>
    </transition>

    <!-- ── Fetch error ───────────────────────────────────────────── -->
    <div v-if="fetchError" class="error-banner">
      <strong>Failed to fetch PRs</strong> — {{ fetchError }}
    </div>

    <!-- ── Loading skeleton ──────────────────────────────────────── -->
    <div v-if="loading" class="loading-state">
      <div class="stats-row stats-row--skeleton">
        <div v-for="n in 3" :key="n" class="skeleton-panel"></div>
      </div>
      <div class="split-layout">
        <div class="split-layout__left">
          <div v-for="n in 8" :key="n" class="skeleton-tree-item"></div>
        </div>
        <div class="split-layout__right">
          <div class="skeleton-block"></div>
          <div class="skeleton-block skeleton-block--short"></div>
        </div>
      </div>
    </div>

    <!-- ── Loaded content ────────────────────────────────────────── -->
    <template v-else-if="results.length">
      <!-- Stats dashboard -->
      <div class="stats-row">
        <!-- Pull Requests overview -->
        <div class="stat-panel">
          <div class="stat-panel__stats">
            <div class="stat-item stat-item--primary">
              <div class="stat-item__value">{{ totalPrCount }}</div>
              <div class="stat-item__label">Open</div>
            </div>
            <div class="stat-item">
              <div class="stat-item__value">{{ reposWithPrsCount }}<span class="stat-item__sub">/{{ results.length }}</span></div>
              <div class="stat-item__label">Repos</div>
            </div>
            <div v-if="outdatedCount" class="stat-item stat-item--slate">
              <div class="stat-item__value">{{ outdatedCount }}</div>
              <div class="stat-item__label">Outdated</div>
            </div>
          </div>
        </div>

        <!-- Build status -->
        <div class="stat-panel">
          <div class="stat-panel__stats">
            <div class="stat-item" :class="passingCount ? 'stat-item--green' : 'stat-item--muted'">
              <div class="stat-item__value">{{ passingCount }}</div>
              <div class="stat-item__label">Passing</div>
            </div>
            <div class="stat-item" :class="failingCount ? 'stat-item--red' : 'stat-item--muted'">
              <div class="stat-item__value">{{ failingCount }}</div>
              <div class="stat-item__label">Failing</div>
            </div>
            <div class="stat-item" :class="pendingCount ? 'stat-item--amber' : 'stat-item--muted'">
              <div class="stat-item__value">{{ pendingCount }}</div>
              <div class="stat-item__label">Pending</div>
            </div>
          </div>
        </div>

        <!-- Actions needed -->
        <div class="stat-panel">
          <div class="stat-panel__stats">
            <div class="stat-item" :class="readyToMergeCount ? 'stat-item--purple' : 'stat-item--muted'">
              <div class="stat-item__value">{{ readyToMergeCount }}</div>
              <div class="stat-item__label">Ready</div>
            </div>
            <div class="stat-item" :class="secondaryReviewCount ? 'stat-item--amber' : 'stat-item--muted'">
              <div class="stat-item__value">{{ secondaryReviewCount }}</div>
              <div class="stat-item__label">2nd review</div>
            </div>
            <div class="stat-item" :class="awaitingReviewCount ? 'stat-item--teal' : 'stat-item--muted'">
              <div class="stat-item__value">{{ awaitingReviewCount }}</div>
              <div class="stat-item__label">Review</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Split pane: Tree + Work area -->
      <div class="split-layout">
        <div class="split-layout__left">
          <TreeView
            :categories="treeCategories"
            :selected-pr-id="selectedPrId"
            @toggle-category="toggleCategory"
            @toggle-repo="toggleRepo"
            @select-pr="selectPr"
          />
        </div>

        <div class="split-layout__right">
          <PrWorkArea
            v-if="selectedPr && selectedRepo && selectedState"
            :repo="selectedRepo"
            :pr="selectedPr"
            :state="selectedState"
            :agent-mode="agentConfig.agent"
            :agent-model="agentConfig.model"
            @approve="approvePr"
            @merge="mergePr"
            @update-branch="updateBranch"
            @fix-with-ai="fixWithAi"
            @apply-known-fix="applyKnownFix"
            @plan-with-ai="planWithAi"
            @execute-plan="executePlan"
            @replan="replanWithComment"
            @discard-plan="discardPlan"
            @stop-fix="stopFix"
            @push-fix="pushFix"
            @discard-fix="discardFix"
            @copy-slack="copySlackMessage"
            @recreate-pr="recreatePr"
            @delete-branch="deleteBranch"
          />
          <div v-else class="work-area-empty">
            <div class="work-area-empty__content">
              <svg aria-hidden="true" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#b1b4b6" stroke-width="1.5">
                <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2"/>
              </svg>
              <p>Select a pull request from the sidebar</p>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- ── Empty state ───────────────────────────────────────────── -->
    <div v-else-if="!loading && !fetchError" class="empty-state">
      <svg aria-hidden="true" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#00703c" stroke-width="1.5">
        <path d="M9 12l2 2 4-4m6 2a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"/>
      </svg>
      <h2 class="empty-state__title">All clear</h2>
      <p class="empty-state__text">No open Dependabot PRs found across any repository.</p>
    </div>
  </div>
</template>

<style scoped>
/* ── Page layout ─────────────────────────────────────────────────── */
.dependabot-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 100vh;
}

/* ── Header ──────────────────────────────────────────────────────── */
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  background: #fff;
  border-bottom: 1px solid #f0f0f0;
  flex-shrink: 0;
}

.page-header__left {
  display: flex;
  align-items: center;
  gap: 14px;
}

.page-header__back {
  font-size: 0.8rem;
  color: #1d70b8;
  text-decoration: none;
  font-weight: 500;
}

.page-header__back:hover {
  text-decoration: underline;
}

.page-header__title {
  font-size: 1.15rem;
  font-weight: 700;
  color: #0b0c0c;
  margin: 0;
}

.page-header__right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.page-header__time {
  font-size: 0.75rem;
  color: #808080;
}

.page-header__monitor-badge {
  font-size: 0.72rem;
  font-weight: 600;
  color: #1d70b8;
  background: #edf4fc;
  border: 1px solid #d8e6f3;
  border-radius: 12px;
  padding: 3px 10px;
  white-space: nowrap;
  animation: pulse-badge 2s ease-in-out infinite;
}

@keyframes pulse-badge {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}

/* ── Update dropdown ─────────────────────────────────────────────── */
.update-dropdown {
  position: relative;
}

.update-dropdown__trigger {
  all: unset;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  font-size: 0.78rem;
  font-weight: 600;
  color: #1d70b8;
  border: 1px solid #d8e6f3;
  border-radius: 6px;
  background: #fff;
  transition: all 0.15s;
  list-style: none;
  user-select: none;
}

.update-dropdown__trigger::-webkit-details-marker {
  display: none;
}

.update-dropdown__trigger::marker {
  display: none;
  content: '';
}

.update-dropdown__trigger:hover {
  background: #edf4fc;
  border-color: #1d70b8;
}

.update-dropdown__trigger--active {
  border-color: #1d70b8;
  background: #edf4fc;
}

.update-dropdown__chevron {
  transition: transform 0.2s;
}

.update-dropdown[open] .update-dropdown__chevron {
  transform: rotate(180deg);
}

.update-dropdown__menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 100;
  min-width: 240px;
  background: #fff;
  border: 1px solid #e5e5e5;
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
  overflow: hidden;
}

.update-dropdown__item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 14px;
  font-size: 0.78rem;
  text-align: left;
  border: none;
  background: none;
  cursor: pointer;
  transition: background 0.1s;
}

.update-dropdown__item--action {
  font-weight: 600;
  color: #1d70b8;
}

.update-dropdown__item--action:hover:not(:disabled) {
  background: #edf4fc;
}

.update-dropdown__item--action:disabled {
  opacity: 0.4;
  cursor: default;
}

.update-dropdown__item--check {
  color: #0b0c0c;
  cursor: pointer;
}

.update-dropdown__item--check:hover {
  background: #f8f8f8;
}

.update-dropdown__checkbox {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  accent-color: #1d70b8;
  cursor: pointer;
}

.update-dropdown__check-label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-weight: 500;
}

.update-dropdown__check-desc {
  font-size: 0.68rem;
  font-weight: 400;
  color: #808080;
  line-height: 1.3;
}

.update-dropdown__divider {
  height: 1px;
  background: #f0f0f0;
  margin: 0;
}

/* ── Reminder timer dropdown ─────────────────────────────────────── */
.reminder-dropdown {
  position: relative;
}

.reminder-dropdown__trigger {
  all: unset;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  font-size: 0.75rem;
  font-weight: 600;
  color: #505a5f;
  border: 1px solid #e5e5e5;
  border-radius: 6px;
  background: #fff;
  transition: all 0.15s;
  list-style: none;
  user-select: none;
}

.reminder-dropdown__trigger::-webkit-details-marker {
  display: none;
}

.reminder-dropdown__trigger::marker {
  display: none;
  content: '';
}

.reminder-dropdown__trigger:hover {
  border-color: #b1b4b6;
  background: #f8f8f8;
}

.reminder-dropdown__trigger--active {
  color: #d4351c;
  border-color: #f5c6c2;
  background: #fef7f0;
  animation: pulse-timer 2s ease-in-out infinite;
}

@keyframes pulse-timer {
  0%, 100% { box-shadow: none; }
  50% { box-shadow: 0 0 0 2px rgba(212, 53, 28, 0.15); }
}

.reminder-dropdown__countdown {
  font-variant-numeric: tabular-nums;
}

.reminder-dropdown__menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 100;
  width: 200px;
  padding: 12px;
  background: #fff;
  border: 1px solid #e5e5e5;
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.reminder-dropdown__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.reminder-dropdown__label {
  font-size: 0.7rem;
  font-weight: 600;
  color: #505a5f;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.reminder-dropdown__input {
  width: 100%;
  padding: 4px 6px;
  font-size: 0.78rem;
  border: 1px solid #d8d8d8;
  border-radius: 4px;
  outline: none;
  transition: border-color 0.15s;
  box-sizing: border-box;
}

.reminder-dropdown__input:focus {
  border-color: #1d70b8;
  box-shadow: 0 0 0 2px rgba(29, 112, 184, 0.15);
}

.reminder-dropdown__toggle {
  display: flex;
  border: 1px solid #d8d8d8;
  border-radius: 4px;
  overflow: hidden;
}

.reminder-dropdown__mode-btn {
  all: unset;
  cursor: pointer;
  flex: 1;
  text-align: center;
  padding: 5px 0;
  font-size: 0.75rem;
  font-weight: 500;
  color: #505a5f;
  background: #fff;
  transition: all 0.15s;
}

.reminder-dropdown__mode-btn + .reminder-dropdown__mode-btn {
  border-left: 1px solid #d8d8d8;
}

.reminder-dropdown__mode-btn--active {
  background: #1d70b8;
  color: #fff;
}

.reminder-dropdown__start {
  all: unset;
  cursor: pointer;
  text-align: center;
  padding: 7px 0;
  font-size: 0.78rem;
  font-weight: 600;
  color: #fff;
  background: #00703c;
  border-radius: 4px;
  transition: background 0.15s;
}

.reminder-dropdown__start:hover {
  background: #005a30;
}

.reminder-dropdown__status {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.reminder-dropdown__progress-bar {
  width: 100%;
  height: 4px;
  background: #f0f0f0;
  border-radius: 2px;
  overflow: hidden;
}

.reminder-dropdown__progress-fill {
  height: 100%;
  background: #1d70b8;
  border-radius: 2px;
  transition: width 1s linear;
}

.reminder-dropdown__status-text {
  font-size: 0.75rem;
  color: #0b0c0c;
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 6px;
}

.reminder-dropdown__mode-badge {
  font-size: 0.65rem;
  font-weight: 600;
  text-transform: uppercase;
  color: #4c6272;
  background: #f0f0f0;
  padding: 1px 5px;
  border-radius: 3px;
}

.reminder-dropdown__stop {
  all: unset;
  cursor: pointer;
  text-align: center;
  padding: 7px 0;
  font-size: 0.78rem;
  font-weight: 600;
  color: #fff;
  background: #d4351c;
  border-radius: 4px;
  transition: background 0.15s;
}

.reminder-dropdown__stop:hover {
  background: #aa2a16;
}

/* ── Toast ───────────────────────────────────────────────────────── */
.toast {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 1000;
  padding: 10px 16px;
  border-radius: 8px;
  font-size: 0.82rem;
  font-weight: 500;
  box-shadow: 0 4px 20px rgba(0,0,0,0.12);
  max-width: 360px;
}

.toast--ok {
  background: #e8f8ee;
  color: #005a30;
  border: 1px solid #b7e7c4;
}

.toast--warn {
  background: #fef7f0;
  color: #6e3619;
  border: 1px solid #f5c98a;
}

.toast-enter-active,
.toast-leave-active {
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(20px);
}

/* ── Error banner ────────────────────────────────────────────────── */
.error-banner {
  padding: 12px 20px;
  background: #fce8e6;
  color: #6e0f0a;
  font-size: 0.82rem;
  border-bottom: 1px solid #f5c6c2;
}

/* ── Stat panels ─────────────────────────────────────────────────── */
.stats-row {
  display: flex;
  gap: 12px;
  padding: 16px 20px;
  background: #fafafa;
  border-bottom: 1px solid #f0f0f0;
  flex-shrink: 0;
}

.stats-row--skeleton {
  padding: 16px 20px;
}

.stat-panel {
  flex: 1;
  background: #fff;
  border: 1px solid #e5e5e5;
  border-radius: 10px;
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
}

.stat-panel__stats {
  display: flex;
  padding: 14px 0;
}

.stat-item {
  text-align: center;
  min-width: 0;
  flex: 1;
  padding: 0 12px;
  border-right: 1px solid #f0f0f0;
}

.stat-item:last-child {
  border-right: none;
}

.stat-item__value {
  font-size: 1.4rem;
  font-weight: 700;
  line-height: 1;
  color: #0b0c0c;
  margin-bottom: 4px;
}

.stat-item__sub {
  font-size: 0.8rem;
  font-weight: 400;
  color: #808080;
}

.stat-item__label {
  font-size: 0.68rem;
  color: #808080;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  line-height: 1.3;
}

.stat-item--primary .stat-item__value { color: #1d70b8; }
.stat-item--green .stat-item__value   { color: #00703c; }
.stat-item--red .stat-item__value     { color: #d4351c; }
.stat-item--amber .stat-item__value   { color: #f47738; }
.stat-item--slate .stat-item__value   { color: #4c6272; }
.stat-item--purple .stat-item__value  { color: #4c2c92; }
.stat-item--teal .stat-item__value    { color: #28a197; }
.stat-item--muted { opacity: 0.4; }

.skeleton-panel {
  flex: 1;
  height: 70px;
  border-radius: 10px;
  background: linear-gradient(90deg, #f0f0f0 25%, #fafafa 50%, #f0f0f0 75%);
  background-size: 200% 100%;
  animation: shimmer 1.4s infinite;
}

/* ── Split layout ────────────────────────────────────────────────── */
.split-layout {
  display: grid;
  grid-template-columns: 280px 1fr;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.split-layout__left {
  min-width: 0;
  overflow: hidden;
  border-right: 1px solid #f0f0f0;
}

.split-layout__right {
  min-width: 0;
  overflow-y: auto;
  background: #fff;
}

/* ── Work area empty ─────────────────────────────────────────────── */
.work-area-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 40px;
}

.work-area-empty__content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: #b1b4b6;
}

.work-area-empty__content p {
  margin: 0;
  font-size: 0.88rem;
}

/* ── Empty state ─────────────────────────────────────────────────── */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 80px 20px;
  text-align: center;
}

.empty-state__title {
  font-size: 1.3rem;
  font-weight: 700;
  color: #00703c;
  margin: 16px 0 8px;
}

.empty-state__text {
  font-size: 0.9rem;
  color: #505a5f;
  margin: 0;
}

/* ── Spinner ─────────────────────────────────────────────────────── */
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

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ── Loading skeletons ───────────────────────────────────────────── */
.loading-state {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.skeleton-tree-item {
  height: 32px;
  margin: 2px 12px;
  border-radius: 4px;
  background: linear-gradient(90deg, #f0f0f0 25%, #fafafa 50%, #f0f0f0 75%);
  background-size: 200% 100%;
  animation: shimmer 1.4s infinite;
}

.skeleton-block {
  height: 120px;
  margin: 20px;
  border-radius: 8px;
  background: linear-gradient(90deg, #f0f0f0 25%, #fafafa 50%, #f0f0f0 75%);
  background-size: 200% 100%;
  animation: shimmer 1.4s infinite;
}

.skeleton-block--short {
  height: 60px;
}

@keyframes shimmer {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
</style>
