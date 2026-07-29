<script setup lang="ts">
import { computed, ref, nextTick, watch } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { ActionState } from '@/types/dependabot'
import DiffViewer from './DiffViewer.vue'

marked.setOptions({ breaks: true, gfm: true })

function sanitize(html: string): string {
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
}

interface CheckFailure {
  name: string
  link: string
  summary: string
}

interface PrDetail {
  number: number
  title: string
  url: string
  body: string
  buildStatus: 'green' | 'amber' | 'red' | 'unknown'
  failedChecks: string[]
  isBehind: boolean
  myApproved: boolean
  approvalCount: number
  approvalsRequired: number
  reviewDecision: string
}

const props = defineProps<{
  repo: string
  pr: PrDetail
  state: ActionState
  agentMode?: 'kiro' | 'ollama'
  agentModel?: string
}>()

const planWithAiLabel = computed(() => {
  if (props.state.planning) return 'Planning…'
  return props.agentMode === 'ollama'
    ? `Plan fix (Ollama · ${props.agentModel ?? 'ollama'})`
    : 'Plan & fix with AI (Kiro)'
})

const fixWithAiLabel = computed(() => {
  if (props.state.fixing) return 'Fixing…'
  if (props.state.fixed) return '✓ Fixed'
  if (props.agentMode === 'ollama') {
    const m = props.agentModel ?? 'ollama'
    return `Fix with AI (Ollama · ${m})`
  }
  return 'Fix directly (no plan)'
})

const emit = defineEmits<{
  (e: 'approve', repo: string, prNumber: number): void
  (e: 'merge', repo: string, prNumber: number): void
  (e: 'update-branch', repo: string, prNumber: number): void
  (e: 'plan-with-ai', repo: string, prNumber: number, extraInstructions?: string): void
  (e: 'execute-plan', repo: string, prNumber: number): void
  (e: 'replan', repo: string, prNumber: number): void
  (e: 'discard-plan', repo: string, prNumber: number): void
  (e: 'fix-with-ai', repo: string, prNumber: number, extraInstructions?: string): void
  (e: 'apply-known-fix', repo: string, prNumber: number, planText: string): void
  (e: 'stop-fix', repo: string, prNumber: number): void
  (e: 'push-fix', repo: string, prNumber: number): void
  (e: 'discard-fix', repo: string, prNumber: number): void
  (e: 'copy-slack', repo: string, pr: PrDetail): void
  (e: 'recreate-pr', repo: string, prNumber: number): void
  (e: 'delete-branch', repo: string, prNumber: number): void
}>()

const canMerge = computed(() => {
  const pr = props.pr
  const state = props.state
  const iAmApproved = pr.myApproved || state.approved
  if (!iAmApproved) return false
  if (state.approved && !pr.myApproved) {
    return pr.approvalCount + 1 >= pr.approvalsRequired
  }
  return pr.reviewDecision === 'APPROVED'
})

const approvalsSoFar = computed(() => {
  return props.state.approved && !props.pr.myApproved
    ? props.pr.approvalCount + 1
    : props.pr.approvalCount
})

const statusLabel = computed(() => {
  switch (props.pr.buildStatus) {
    case 'green': return 'Passing'
    case 'amber': return 'Pending'
    case 'red': return 'Failing'
    default: return 'Unknown'
  }
})

const statusClass = computed(() => `status-badge--${props.pr.buildStatus}`)

function renderSummaryMarkdown(raw: string): string {
  if (!raw) return ''
  const escaped = raw
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
  const html = escaped
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
    .replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/^(?!<[hul])(.+)$/gm, '<p>$1</p>')
    .replaceAll('<p></p>', '')
  return sanitize(html)
}

// ── Dropdown menu positioning (fixed to escape overflow clipping) ──
const menuOpen = ref(false)
const menuStyle = ref<Record<string, string>>({})
const menuTriggerRef = ref<HTMLElement | null>(null)

function toggleMenu() {
  menuOpen.value = !menuOpen.value
  if (menuOpen.value) {
    nextTick(() => positionMenu())
  }
}

function positionMenu() {
  if (!menuTriggerRef.value) return
  const rect = menuTriggerRef.value.getBoundingClientRect()
  const spaceBelow = globalThis.innerHeight - rect.bottom
  const menuHeight = 260 // approximate max height of menu

  if (spaceBelow < menuHeight) {
    // Open upward
    menuStyle.value = {
      position: 'fixed',
      right: `${globalThis.innerWidth - rect.right}px`,
      bottom: `${globalThis.innerHeight - rect.top + 4}px`,
      top: 'auto',
    }
  } else {
    // Open downward
    menuStyle.value = {
      position: 'fixed',
      right: `${globalThis.innerWidth - rect.right}px`,
      top: `${rect.bottom + 4}px`,
      bottom: 'auto',
    }
  }
}

function closeMenu() {
  menuOpen.value = false
}

// ── Build failure details ──
const failureDetailsOpen = ref(false)
const failureDetails = ref<CheckFailure[]>([])
const failureLoading = ref(false)

watch(() => props.pr?.number, () => {
  failureDetailsOpen.value = false
  failureDetails.value = []
})

async function toggleFailureDetails() {
  if (failureDetailsOpen.value) {
    failureDetailsOpen.value = false
    return
  }
  failureDetailsOpen.value = true
  if (failureDetails.value.length > 0) return
  failureLoading.value = true
  try {
    const res = await fetch(`/api/dependabot-check-failures?repo=${encodeURIComponent(props.repo)}&prNumber=${props.pr.number}`)
    const data = await res.json()
    failureDetails.value = data.failures ?? []
  } catch {
    failureDetails.value = []
  } finally {
    failureLoading.value = false
  }
}

function showInstructions() {
  props.state.showInstructionsInput = true
}

function cancelInstructions() {
  props.state.showInstructionsInput = false
}

function runFixWithInstructions() {
  const instructions = props.state.extraInstructions.trim()
  props.state.showInstructionsInput = false
  emit('plan-with-ai', props.repo, props.pr.number, instructions || undefined)
}

const isAgentBusy = computed(() =>
  props.state.planning || props.state.fixing
)

function renderPlanMarkdown(raw: string): string {
  return renderSummaryMarkdown(raw)
}
</script>

<template>
  <div class="work-area">
    <!-- Empty state -->
    <div v-if="!pr" class="work-area__empty">
      <p class="govuk-body">Select a pull request from the tree to view details.</p>
    </div>

    <template v-else>
      <!-- TOP CARD: PR Status & Actions -->
      <div class="work-area__card work-area__card--top">
        <div class="work-area__card-header">
          <div class="work-area__pr-identity">
            <span class="work-area__pr-number">#{{ pr.number }}</span>
            <a
              :href="pr.url"
              target="_blank"
              rel="noopener noreferrer"
              class="govuk-link work-area__pr-title"
            >
              {{ pr.title }}
            </a>
          </div>
          <div class="work-area__header-right">
            <div class="work-area__badges">
              <span
                v-if="pr.isBehind && !state.updated"
                class="status-badge status-badge--outdated"
              >
                <span class="status-badge__dot"></span>
                Outdated
              </span>
            </div>
            <!-- Overflow menu (⋮) -->
            <div v-if="!state.deleted" class="work-area__menu" @click.stop>
              <button
                ref="menuTriggerRef"
                class="work-area__menu-trigger"
                aria-label="More actions"
                @click="toggleMenu"
              >⋮</button>
              <Teleport to="body">
                <div v-if="menuOpen" class="work-area__menu-backdrop" @click="closeMenu"></div>
                <ul v-if="menuOpen" class="work-area__menu-list" :style="menuStyle" @click="closeMenu">
                  <!-- Approve -->
                  <li v-if="!state.approved && !pr.myApproved && pr.buildStatus !== 'red' && (!pr.isBehind || state.updated)">
                    <button
                      class="work-area__menu-item work-area__menu-item--approve"
                      :disabled="state.approving"
                      @click="emit('approve', repo, pr.number)"
                    >
                      {{ state.approving ? 'Approving…' : 'Approve PR' }}
                    </button>
                  </li>

                  <!-- AI Fix group -->
                  <li v-if="!state.approved && !pr.myApproved && pr.buildStatus !== 'red' && (!pr.isBehind || state.updated)"><hr class="work-area__menu-divider" /></li>
                  <li class="work-area__menu-group-label">AI fix</li>
                  <li>
                    <button
                      class="work-area__menu-item work-area__menu-item--ai-primary"
                      :disabled="isAgentBusy || state.fixed"
                      @click="emit('plan-with-ai', repo, pr.number)"
                    >
                      {{ isAgentBusy ? planWithAiLabel : '✦ Plan &amp; fix with Kiro' }}
                    </button>
                  </li>
                  <li>
                    <button
                      class="work-area__menu-item work-area__menu-item--ai-secondary"
                      :disabled="isAgentBusy || state.fixed"
                      @click="showInstructions"
                    >
                      With instructions…
                    </button>
                  </li>
                  <li>
                    <button
                      class="work-area__menu-item work-area__menu-item--ai-secondary"
                      :disabled="isAgentBusy || state.fixed"
                      @click="emit('fix-with-ai', repo, pr.number)"
                    >
                      Fix directly (no plan)
                    </button>
                  </li>

                  <!-- PR commands group -->
                  <li><hr class="work-area__menu-divider" /></li>
                  <li class="work-area__menu-group-label">Branch commands</li>
                  <li>
                    <button
                      class="work-area__menu-item"
                      :disabled="state.updating || state.updated"
                      @click="emit('update-branch', repo, pr.number)"
                    >
                      {{ state.updating ? 'Updating…' : state.updated ? '✓ Branch updated' : 'Update branch' }}
                    </button>
                  </li>
                  <li>
                    <button
                      class="work-area__menu-item"
                      :disabled="state.recreating || state.recreated"
                      @click="emit('recreate-pr', repo, pr.number)"
                    >
                      {{ state.recreating ? 'Recreating…' : state.recreated ? '✓ Recreated' : 'Recreate PR' }}
                    </button>
                  </li>

                  <!-- Other -->
                  <li><hr class="work-area__menu-divider" /></li>
                  <li>
                    <button
                      class="work-area__menu-item work-area__menu-item--copy"
                      @click="emit('copy-slack', repo, pr)"
                    >
                      Copy for Slack
                    </button>
                  </li>
                  <li>
                    <button
                      class="work-area__menu-item work-area__menu-item--danger"
                      :disabled="state.deleting"
                      @click="emit('delete-branch', repo, pr.number)"
                    >
                      {{ state.deleting ? 'Deleting…' : 'Delete branch' }}
                    </button>
                  </li>
                </ul>
              </Teleport>
            </div>
          </div>
        </div>

        <div class="work-area__card-body">
          <div v-if="pr.body" class="work-area__pr-description" v-html="sanitize(marked.parse(pr.body) as string)"></div>

          <!-- Build failure info -->
          <div v-if="pr.buildStatus === 'red' && pr.failedChecks?.length" class="work-area__build-failures">
            <button class="work-area__failures-toggle" @click="toggleFailureDetails">
              <span class="work-area__failures-icon">✕</span>
              {{ pr.failedChecks.length }} check{{ pr.failedChecks.length !== 1 ? 's' : '' }} failing:
              <span class="work-area__failures-names">{{ pr.failedChecks.join(', ') }}</span>
              <span class="work-area__failures-chevron">{{ failureDetailsOpen ? '▾' : '▸' }}</span>
            </button>
            <div v-if="failureDetailsOpen" class="work-area__failures-detail">
              <p v-if="failureLoading" class="work-area__failures-loading">Loading details…</p>
              <template v-else-if="failureDetails.length">
                <div v-for="failure in failureDetails" :key="failure.name" class="work-area__failure-item">
                  <a v-if="failure.link" :href="failure.link" target="_blank" rel="noopener noreferrer" class="govuk-link">
                    {{ failure.name }}
                  </a>
                  <strong v-else>{{ failure.name }}</strong>
                  <span class="work-area__failure-summary">{{ failure.summary }}</span>
                </div>
              </template>
              <p v-else class="work-area__failures-loading">No additional details available.</p>
            </div>
          </div>

          <!-- Primary Actions -->
          <div class="work-area__primary-actions">
            <!-- Deleted state -->
            <span v-if="state.deleted" class="work-area__done-badge">✓ Branch deleted</span>

            <template v-else>
              <!-- Merge (only shown when eligible) -->
              <template v-if="canMerge">
                <span v-if="state.merged" class="work-area__done-badge">✓ Merge queued</span>
                <button
                  v-else
                  class="govuk-button govuk-!-margin-bottom-0"
                  :disabled="state.merging"
                  @click="emit('merge', repo, pr.number)"
                >
                  {{ state.merging ? 'Merging…' : 'Merge PR' }}
                </button>
                <span v-if="state.mergeError" class="work-area__error">{{ state.mergeError }}</span>
              </template>

              <!-- Approval status info -->
              <template v-else-if="pr.myApproved || state.approved">
                <span class="work-area__approval-info">
                  {{ approvalsSoFar }} of {{ pr.approvalsRequired }} approval{{ pr.approvalsRequired !== 1 ? 's' : '' }} —
                  {{ pr.approvalsRequired - approvalsSoFar }} more needed
                </span>
              </template>

              <!-- Inline errors -->
              <span v-if="state.approveError" class="work-area__error">{{ state.approveError }}</span>
              <span v-if="state.updateError" class="work-area__error">
                {{ state.updateError }}
                <template v-if="state.updateError?.includes('workflow')">
                  — your token needs the <strong>workflow</strong> scope.
                </template>
              </span>
              <span v-if="state.fixError" class="work-area__error">{{ state.fixError }}</span>
            </template>
          </div>

          <!-- Inline errors -->
          <div v-if="state.deleteError || state.recreateError" class="work-area__errors">
            <span v-if="state.deleteError" class="work-area__error">{{ state.deleteError }}</span>
            <span v-if="state.recreateError" class="work-area__error">{{ state.recreateError }}</span>
          </div>
        </div>
      </div>

      <!-- Extra instructions input -->
      <div v-if="state.showInstructionsInput" class="work-area__card work-area__card--instructions">
        <div class="work-area__card-header">
          <h3 class="work-area__section-title">Extra instructions for AI agent</h3>
        </div>
        <div class="work-area__card-body">
          <p class="govuk-body-s govuk-!-margin-bottom-2">Provide additional context or commands to help the AI agent fix this PR. This will be appended to the agent's prompt.</p>
          <textarea
            v-model="state.extraInstructions"
            class="govuk-textarea work-area__instructions-input"
            rows="5"
            placeholder="e.g. The test file uses a mock from __mocks__/apiClient.ts that also needs updating. The new API returns a Promise<Result> instead of Result."
          ></textarea>
          <div class="work-area__instructions-actions">
            <button
              class="govuk-button govuk-!-margin-bottom-0"
              @click="runFixWithInstructions"
            >
              Run fix with instructions
            </button>
            <button
              class="govuk-button govuk-button--secondary govuk-!-margin-bottom-0"
              @click="cancelInstructions"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>


      <!-- FIX SUGGESTION: Known fix from another repo -->
      <div
        v-if="state.fixSuggestions.length && !state.planning && !state.fixing && !state.fixDiff && !state.pendingPlanJobId"
        class="work-area__card work-area__card--suggestion"
      >
        <div class="work-area__card-header work-area__card-header--suggestion">
          <h3 class="work-area__section-title">
            💡 Known fix available
          </h3>
        </div>
        <div v-for="suggestion in state.fixSuggestions" :key="suggestion.entry.id" class="work-area__suggestion-item">
          <p class="govuk-body-s govuk-!-margin-bottom-1">
            <strong>{{ suggestion.entry.fixDescription }}</strong>
          </p>
          <p class="govuk-body-s govuk-!-margin-bottom-2 work-area__suggestion-reason">
            {{ suggestion.reason }}
          </p>
          <p v-if="suggestion.entry.appliedTo.length > 1" class="govuk-body-s govuk-!-margin-bottom-2">
            Successfully applied to {{ suggestion.entry.appliedTo.length }} repo{{ suggestion.entry.appliedTo.length !== 1 ? 's' : '' }}
          </p>
          <div class="work-area__suggestion-actions">
            <button
              class="govuk-button govuk-button--secondary govuk-!-margin-bottom-0"
              @click="emit('apply-known-fix', repo, pr.number, suggestion.entry.planText)"
            >
              Apply this fix
            </button>
            <span class="govuk-tag" :class="suggestion.confidence === 'high' ? 'govuk-tag--green' : 'govuk-tag--yellow'">
              {{ suggestion.confidence }} confidence
            </span>
          </div>
        </div>
      </div>

      <!-- PLAN CARD: AI Fix Plan awaiting review -->
      <div
        v-if="state.planning || state.planText || state.pendingPlanJobId || state.planError"
        class="work-area__card work-area__card--plan"
      >
        <div class="work-area__card-header work-area__card-header--ai">
          <h3 class="work-area__section-title">
            AI Fix Plan
            <span class="work-area__agent-badge">Kiro</span>
          </h3>
          <div class="work-area__ai-controls">
            <button
              v-if="state.planning"
              class="work-area__stop-btn"
              :disabled="state.stopping"
              @click="emit('stop-fix', repo, pr.number)"
            >
              {{ state.stopping ? 'Stopping…' : 'Stop' }}
            </button>
            <span v-if="state.planning" class="work-area__running-indicator">
              <span class="btn-spinner btn-spinner--dark" aria-hidden="true"></span> Analysing…
            </span>
          </div>
        </div>

        <div v-if="state.planError" class="work-area__error work-area__error--block">{{ state.planError }}</div>

        <!-- Plan text -->
        <div
          v-if="state.planText"
          class="work-area__plan-body"
          v-html="renderPlanMarkdown(state.planText)"
        ></div>

        <!-- Action buttons when plan is ready -->
        <div v-if="state.pendingPlanJobId && !state.planning" class="work-area__plan-actions">
          <button
            class="govuk-button govuk-!-margin-bottom-0"
            @click="emit('execute-plan', repo, pr.number)"
          >
            Approve plan &amp; fix
          </button>
          <button
            class="govuk-button govuk-button--secondary govuk-!-margin-bottom-0"
            @click="state.showReplanInput = !state.showReplanInput"
          >
            {{ state.showReplanInput ? 'Cancel replan' : 'Replan with comments' }}
          </button>
          <button
            class="govuk-button govuk-button--warning govuk-!-margin-bottom-0"
            @click="emit('discard-plan', repo, pr.number)"
          >
            Discard
          </button>
        </div>

        <!-- Replan comment input -->
        <div v-if="state.showReplanInput" class="work-area__replan-input">
          <textarea
            v-model="state.replanComment"
            class="govuk-textarea work-area__instructions-input"
            rows="4"
            placeholder="e.g. Also update the mock in __mocks__/apiClient.ts. The axios change should not affect the retry logic in retryHelper.ts."
          ></textarea>
          <div class="work-area__instructions-actions">
            <button
              class="govuk-button govuk-!-margin-bottom-0"
              :disabled="state.planning"
              @click="emit('replan', repo, pr.number)"
            >
              Re-analyse with comments
            </button>
          </div>
        </div>

        <!-- Plan agent log (collapsible) — hidden once execution phase starts to avoid duplicate log panels -->
        <details v-if="state.planLog.length && !state.fixing && !state.fixLog.length" class="work-area__accordion" :open="state.showPlanLog">
          <summary
            class="work-area__accordion-trigger work-area__accordion-trigger--log"
            @click.prevent="state.showPlanLog = !state.showPlanLog"
          >
            <span class="tree-view__chevron" :class="{ 'tree-view__chevron--open': state.showPlanLog }">›</span>
            Agent output log
          </summary>
          <pre v-if="state.showPlanLog" class="work-area__log-output">{{ state.planLog.join('\n') }}</pre>
        </details>
      </div>

      <!-- BOTTOM CARD: AI Resolution & Diff -->
      <div
        v-if="state.fixLog.length || state.fixDiff || state.fixSummary || state.pendingJobId || state.discarded || state.fixing"
        class="work-area__card work-area__card--bottom"
      >
        <div class="work-area__card-header work-area__card-header--ai">
          <h3 class="work-area__section-title">
            AI Resolution
            <span class="work-area__agent-badge">
              {{ agentMode === 'ollama' ? `Ollama · ${agentModel ?? 'ollama'}` : 'Kiro' }}
            </span>
          </h3>
          <div class="work-area__ai-controls">
            <button
              v-if="state.fixing"
              class="work-area__stop-btn"
              :disabled="state.stopping"
              @click="emit('stop-fix', repo, pr.number)"
            >
              {{ state.stopping ? 'Stopping…' : 'Stop' }}
            </button>
            <span v-if="state.fixing" class="work-area__running-indicator">
              <span class="btn-spinner btn-spinner--dark" aria-hidden="true"></span> Running…
            </span>
          </div>
        </div>

        <!-- AI Fix Summary (accordion) -->
        <details
          v-if="state.fixSummary"
          class="work-area__accordion"
          open
        >
          <summary class="work-area__accordion-trigger">
            <span class="tree-view__chevron tree-view__chevron--open">›</span>
            What was changed and why
          </summary>
          <div class="work-area__accordion-content" v-html="renderSummaryMarkdown(state.fixSummary)"></div>
        </details>

        <!-- Diff viewer -->
        <template v-if="state.pendingJobId && state.fixDiff">
          <div class="work-area__diff-header">
            <span class="work-area__diff-title">Changes to be pushed</span>
            <span class="govuk-tag govuk-tag--yellow">Awaiting approval</span>
          </div>
          <DiffViewer :raw-diff="state.fixDiff" />
          <div class="work-area__push-actions">
            <button
              class="govuk-button govuk-!-margin-bottom-0"
              :disabled="state.pushing"
              @click="emit('push-fix', repo, pr.number)"
            >
              {{ state.pushing ? 'Pushing…' : 'Allow changes and push' }}
            </button>
            <button
              class="govuk-button govuk-button--warning govuk-!-margin-bottom-0"
              :disabled="state.pushing"
              @click="emit('discard-fix', repo, pr.number)"
            >
              Discard
            </button>
            <span v-if="state.pushError" class="work-area__error">{{ state.pushError }}</span>
          </div>
        </template>

        <!-- Fix log (collapsible) -->
        <details v-if="state.fixLog.length" class="work-area__accordion" :open="state.showFixLog">
          <summary
            class="work-area__accordion-trigger work-area__accordion-trigger--log"
            @click.prevent="state.showFixLog = !state.showFixLog"
          >
            <span class="tree-view__chevron" :class="{ 'tree-view__chevron--open': state.showFixLog }">›</span>
            Agent output log
          </summary>
          <pre v-if="state.showFixLog" class="work-area__log-output">{{ state.fixLog.join('\n') }}</pre>
        </details>

        <!-- Discarded message -->
        <div v-if="state.discarded" class="govuk-inset-text govuk-!-margin-top-2 govuk-!-margin-bottom-0">
          Changes discarded. The temporary clone has been removed.
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.work-area {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 20px;
  height: 100%;
  overflow-y: auto;
}

.work-area__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #505a5f;
}

/* ── Cards ───────────────────────────────────────────────────────── */
.work-area__card {
  border: 1px solid #e5e5e5;
  border-radius: 10px;
  overflow: hidden;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
}

.work-area__card--plan {
  border-color: #4c2c92;
}

.work-area__card--suggestion {
  border-color: #f47738;
  background: #fef7f3;
}

.work-area__card-header--suggestion {
  background: #fef7f3;
  border-bottom-color: #f4773833;
}

.work-area__suggestion-item {
  padding: 12px 20px;
}

.work-area__suggestion-reason {
  color: #505a5f;
}

.work-area__suggestion-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.work-area__plan-body {
  padding: 16px 20px;
  font-size: 0.875rem;
  line-height: 1.6;
  overflow-x: auto;
}

.work-area__plan-actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  padding: 0 20px 16px;
}

.work-area__replan-input {
  padding: 0 20px 16px;
}

.work-area__error--block {
  padding: 12px 20px;
  color: #d4351c;
}

.work-area__card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 16px 20px 12px;
  border-bottom: 1px solid #f0f0f0;
}

.work-area__header-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.work-area__card-header--ai {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #fafafa;
  padding: 12px 20px;
  border-bottom: 1px solid #f0f0f0;
}

.work-area__card-body {
  padding: 16px 20px;
}

/* ── PR Identity ─────────────────────────────────────────────────── */
.work-area__pr-identity {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.work-area__pr-number {
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 1.1rem;
  font-weight: 700;
  color: #808080;
  flex-shrink: 0;
}

.work-area__pr-title {
  font-size: 1rem;
  font-weight: 600;
  color: #0b0c0c;
  word-break: break-word;
  text-decoration: none;
}

.work-area__pr-title:hover {
  text-decoration: underline;
  color: #1d70b8;
}

/* ── PR Description ──────────────────────────────────────────────── */
.work-area__pr-description {
  font-size: 0.84rem;
  color: #0b0c0c;
  margin: 0 0 16px;
  line-height: 1.6;
  word-break: break-word;
  max-height: 200px;
  overflow-y: auto;
  padding: 12px 14px;
  background: #fafafa;
  border-radius: 6px;
  border: 1px solid #f0f0f0;
}

.work-area__pr-description :deep(h1),
.work-area__pr-description :deep(h2),
.work-area__pr-description :deep(h3),
.work-area__pr-description :deep(h4) {
  margin: 0.6em 0 0.3em;
  font-size: 0.88rem;
  font-weight: 700;
}

.work-area__pr-description :deep(p) {
  margin: 0.4em 0;
}

.work-area__pr-description :deep(ul),
.work-area__pr-description :deep(ol) {
  margin: 0.4em 0;
  padding-left: 1.4em;
}

.work-area__pr-description :deep(code) {
  background: #e8e8e8;
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 0.78rem;
}

.work-area__pr-description :deep(pre) {
  background: #e8e8e8;
  padding: 8px 12px;
  border-radius: 4px;
  overflow-x: auto;
  font-size: 0.78rem;
}

.work-area__pr-description :deep(a) {
  color: #1d70b8;
  text-decoration: underline;
}

/* ── Build failure details ───────────────────────────────────────── */
.work-area__build-failures {
  background: #fef5f5;
  border: 1px solid #f5c6c2;
  border-radius: 8px;
  padding: 12px 16px;
  margin: 0 0 16px;
  font-size: 0.84rem;
}

.work-area__failures-toggle {
  all: unset;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  font-size: 0.82rem;
  color: #0b0c0c;
  font-weight: 600;
}

.work-area__failures-icon {
  color: #d4351c;
  font-weight: 700;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fcd6d3;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.7rem;
  flex-shrink: 0;
}

.work-area__failures-names {
  font-weight: 400;
  color: #505a5f;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.work-area__failures-chevron {
  margin-left: auto;
  flex-shrink: 0;
  color: #808080;
  font-size: 0.7rem;
}

.work-area__failures-detail {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid #f0d0cc;
}

.work-area__failure-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 0;
  border-bottom: 1px solid #f5e0dd;
}

.work-area__failure-item:last-child {
  border-bottom: none;
}

.work-area__failure-summary {
  color: #505a5f;
  font-size: 0.76rem;
  line-height: 1.4;
}

.work-area__failures-loading {
  color: #505a5f;
  font-style: italic;
  margin: 0;
  font-size: 0.8rem;
}

/* ── Badges ──────────────────────────────────────────────────────── */
.work-area__badges {
  display: flex;
  gap: 8px;
}

.status-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 0.72rem;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: 12px;
  white-space: nowrap;
}

.status-badge__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-badge--green { background: #e8f8ee; color: #005a30; }
.status-badge--green .status-badge__dot { background: #00703c; }
.status-badge--amber { background: #fef7f0; color: #594d00; }
.status-badge--amber .status-badge__dot { background: #f47738; }
.status-badge--red { background: #fce8e6; color: #6e0f0a; }
.status-badge--red .status-badge__dot { background: #d4351c; }
.status-badge--unknown { background: #f3f2f1; color: #505a5f; }
.status-badge--unknown .status-badge__dot { background: #b1b4b6; }
.status-badge--outdated { background: #eef0f2; color: #383f47; }
.status-badge--outdated .status-badge__dot { background: #4c6272; }

/* ── Primary Actions ─────────────────────────────────────────────── */
.work-area__primary-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.work-area__done-badge {
  font-size: 0.8rem;
  font-weight: 600;
  color: #00703c;
  background: #e8f8ee;
  padding: 5px 12px;
  border-radius: 6px;
}

.work-area__approval-info {
  font-size: 0.78rem;
  color: #594d00;
  background: #fef7f0;
  border: 1px solid #f5c98a;
  border-radius: 6px;
  padding: 5px 12px;
}

.work-area__error {
  font-size: 0.78rem;
  color: #d4351c;
}

.work-area__errors {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* ── Overflow menu ───────────────────────────────────────────────── */
.work-area__menu {
  position: relative;
}

.work-area__menu-trigger {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 6px;
  border: 1px solid #e5e5e5;
  background: #fff;
  cursor: pointer;
  font-size: 1.2rem;
  color: #505a5f;
  user-select: none;
  transition: all 0.15s;
}

.work-area__menu-trigger:hover {
  background: #f3f2f1;
  border-color: #b1b4b6;
  color: #0b0c0c;
}

/* ── AI Section ──────────────────────────────────────────────────── */
.work-area__section-title {
  font-size: 0.84rem;
  font-weight: 700;
  margin: 0;
  color: #0b0c0c;
}

.work-area__ai-controls {
  display: flex;
  align-items: center;
  gap: 10px;
}

.work-area__agent-badge {
  display: inline-block;
  margin-left: 8px;
  padding: 2px 8px;
  font-size: 0.68rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  background: #edf4fc;
  color: #1d70b8;
  border-radius: 4px;
  vertical-align: middle;
}

.work-area__stop-btn {
  font-size: 0.75rem;
  font-weight: 600;
  background: #d4351c;
  border: none;
  color: #fff;
  border-radius: 6px;
  padding: 4px 12px;
  cursor: pointer;
  transition: background 0.15s;
}

.work-area__stop-btn:hover:not(:disabled) {
  background: #aa2a15;
}

.work-area__stop-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.work-area__running-indicator {
  font-size: 0.75rem;
  color: #505a5f;
  display: flex;
  align-items: center;
  gap: 5px;
}

/* ── Accordion ───────────────────────────────────────────────────── */
.work-area__accordion {
  border-top: 1px solid #f0f0f0;
}

.work-area__accordion-trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 20px;
  cursor: pointer;
  font-size: 0.82rem;
  font-weight: 600;
  color: #0b0c0c;
  background: #fafafa;
  list-style: none;
  transition: background 0.1s;
}

.work-area__accordion-trigger::-webkit-details-marker { display: none; }

.work-area__accordion-trigger:hover {
  background: #f0f0f0;
}

.work-area__accordion-trigger--log {
  background: #f5f5f5;
}

.work-area__accordion-content {
  padding: 14px 20px;
  font-size: 0.84rem;
  line-height: 1.6;
  color: #0b0c0c;
  max-height: 280px;
  overflow-y: auto;
}

.work-area__accordion-content :deep(h2),
.work-area__accordion-content :deep(h3),
.work-area__accordion-content :deep(h4) {
  margin: 0 0 8px;
  font-size: 0.9rem;
  font-weight: 700;
}

.work-area__accordion-content :deep(p) {
  margin: 0 0 8px;
}

.work-area__accordion-content :deep(ul) {
  margin: 0 0 8px;
  padding-left: 20px;
  list-style: disc;
}

.work-area__accordion-content :deep(li) {
  margin-bottom: 4px;
}

.work-area__accordion-content :deep(code) {
  background: #f3f2f1;
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 0.78rem;
}

/* ── Diff section ────────────────────────────────────────────────── */
.work-area__diff-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 20px;
  background: #fafafa;
  border-top: 1px solid #f0f0f0;
  border-bottom: 1px solid #f0f0f0;
}

.work-area__diff-title {
  font-size: 0.82rem;
  font-weight: 700;
  color: #0b0c0c;
}

.work-area__push-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 20px;
  background: #fafafa;
  border-top: 1px solid #f0f0f0;
}

/* ── Log output ──────────────────────────────────────────────────── */
.work-area__log-output {
  margin: 0;
  padding: 14px 20px;
  background: #1a1a2e;
  color: #d4d4d4;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 0.76rem;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 320px;
  overflow-y: auto;
}

/* ── Spinner ─────────────────────────────────────────────────────── */
.btn-spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid rgba(255, 255, 255, 0.4);
  border-top-color: #fff;
  border-radius: 50%;
  animation: btn-spin 0.7s linear infinite;
  flex-shrink: 0;
}

.btn-spinner--dark {
  border-color: rgba(0, 0, 0, 0.15);
  border-top-color: #505a5f;
  width: 10px;
  height: 10px;
}

@keyframes btn-spin {
  to { transform: rotate(360deg); }
}

/* ── Instructions input ──────────────────────────────────────────── */
.work-area__card--instructions {
  border-color: #1d70b8;
  border-width: 2px;
}

.work-area__instructions-input {
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 0.82rem;
  resize: vertical;
  min-height: 80px;
  border: 1px solid #e5e5e5;
  border-radius: 6px;
  padding: 10px 12px;
  width: 100%;
  box-sizing: border-box;
}

.work-area__instructions-input:focus {
  outline: none;
  border-color: #1d70b8;
  box-shadow: 0 0 0 2px rgba(29,112,184,0.15);
}

.work-area__instructions-actions {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-top: 12px;
}
</style>

<!-- Unscoped styles for teleported menu -->
<style>
.work-area__menu-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9998;
}

.work-area__menu-list {
  z-index: 9999;
  background: #fff;
  border: 1px solid #e5e5e5;
  border-radius: 8px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.12);
  min-width: 230px;
  list-style: none;
  margin: 0;
  padding: 4px 0;
}

.work-area__menu-group-label {
  padding: 6px 16px 2px;
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #505a5f;
  pointer-events: none;
}

.work-area__menu-item {
  display: block;
  width: 100%;
  padding: 8px 16px;
  text-align: left;
  font-family: inherit;
  font-size: 0.8rem;
  font-weight: 500;
  background: none;
  border: none;
  cursor: pointer;
  color: #0b0c0c;
  transition: background 0.1s;
}

.work-area__menu-item:hover:not(:disabled) { background: #f5f5f5; }
.work-area__menu-item:disabled { opacity: 0.4; cursor: default; }
.work-area__menu-item--approve { color: #00703c; font-weight: 600; }
.work-area__menu-item--approve:hover:not(:disabled) { background: #e8f8ee; }
.work-area__menu-item--danger { color: #d4351c; }
.work-area__menu-item--danger:hover:not(:disabled) { background: #fce8e6; }
.work-area__menu-item--done { color: #00703c; }
.work-area__menu-item--ai-primary { color: #4c2c92; font-weight: 600; padding-left: 16px; }
.work-area__menu-item--ai-primary:hover:not(:disabled) { background: #f3f0f9; }
.work-area__menu-item--ai-secondary { padding-left: 28px; color: #505a5f; font-size: 0.775rem; }
.work-area__menu-item--ai-secondary:hover:not(:disabled) { background: #f5f5f5; }

.work-area__menu-divider {
  border-top: 1px solid #f0f0f0;
  margin: 4px 0;
}

/* AI section */
.work-area__section-title {
  font-size: 0.84rem;
  font-weight: 700;
  margin: 0;
  color: #0b0c0c;
}

.work-area__ai-controls {
  display: flex;
  align-items: center;
  gap: 10px;
}

.work-area__agent-badge {
  display: inline-block;
  margin-left: 8px;
  padding: 2px 8px;
  font-size: 0.68rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  background: #edf4fc;
  color: #1d70b8;
  border-radius: 4px;
  vertical-align: middle;
}

.work-area__stop-btn {
  font-size: 0.75rem;
  font-weight: 600;
  background: #d4351c;
  border: none;
  color: #fff;
  border-radius: 6px;
  padding: 4px 12px;
  cursor: pointer;
  transition: background 0.15s;
}

.work-area__stop-btn:hover:not(:disabled) {
  background: #aa2a15;
}

.work-area__stop-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.work-area__running-indicator {
  font-size: 0.75rem;
  color: #505a5f;
  display: flex;
  align-items: center;
  gap: 5px;
}

/* Accordion */
.work-area__accordion {
  border-top: 1px solid #f0f0f0;
}

.work-area__accordion-trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 20px;
  cursor: pointer;
  font-size: 0.82rem;
  font-weight: 600;
  color: #0b0c0c;
  background: #fafafa;
  list-style: none;
  transition: background 0.1s;
}

.work-area__accordion-trigger::-webkit-details-marker { display: none; }

.work-area__accordion-trigger:hover {
  background: #f0f0f0;
}

.work-area__accordion-trigger--log {
  background: #f5f5f5;
}

.work-area__accordion-content {
  padding: 14px 20px;
  font-size: 0.84rem;
  line-height: 1.6;
  color: #0b0c0c;
  max-height: 280px;
  overflow-y: auto;
}

.work-area__accordion-content :deep(h2),
.work-area__accordion-content :deep(h3),
.work-area__accordion-content :deep(h4) {
  margin: 0 0 8px;
  font-size: 0.9rem;
  font-weight: 700;
}

.work-area__accordion-content :deep(p) {
  margin: 0 0 8px;
}

.work-area__accordion-content :deep(ul) {
  margin: 0 0 8px;
  padding-left: 20px;
  list-style: disc;
}

.work-area__accordion-content :deep(li) {
  margin-bottom: 4px;
}

.work-area__accordion-content :deep(code) {
  background: #f3f2f1;
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 0.78rem;
}

/* Diff section */
.work-area__diff-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 20px;
  background: #fafafa;
  border-top: 1px solid #f0f0f0;
  border-bottom: 1px solid #f0f0f0;
}

.work-area__diff-title {
  font-size: 0.82rem;
  font-weight: 700;
  color: #0b0c0c;
}

.work-area__push-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 20px;
  background: #fafafa;
  border-top: 1px solid #f0f0f0;
}

/* Log output */
.work-area__log-output {
  margin: 0;
  padding: 14px 20px;
  background: #1a1a2e;
  color: #d4d4d4;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 0.76rem;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 320px;
  overflow-y: auto;
}

/* Spinner */
.btn-spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid rgba(255, 255, 255, 0.4);
  border-top-color: #fff;
  border-radius: 50%;
  animation: btn-spin 0.7s linear infinite;
  flex-shrink: 0;
}

.btn-spinner--dark {
  border-color: rgba(0, 0, 0, 0.15);
  border-top-color: #505a5f;
  width: 10px;
  height: 10px;
}

@keyframes btn-spin {
  to { transform: rotate(360deg); }
}

/* Instructions input */
.work-area__card--instructions {
  border-color: #1d70b8;
  border-width: 2px;
}

.work-area__instructions-input {
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 0.82rem;
  resize: vertical;
  min-height: 80px;
  border: 1px solid #e5e5e5;
  border-radius: 6px;
  padding: 10px 12px;
  width: 100%;
  box-sizing: border-box;
}

.work-area__instructions-input:focus {
  outline: none;
  border-color: #1d70b8;
  box-shadow: 0 0 0 2px rgba(29,112,184,0.15);
}

.work-area__instructions-actions {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-top: 12px;
}
</style>
