<script setup lang="ts">
import { ref, computed } from 'vue'
import type { PrStatus } from '@/types/dependabot'

interface TreePr {
  number: number
  title: string
  status: PrStatus
}

interface TreeRepo {
  name: string
  prs: TreePr[]
  error?: boolean
  expanded: boolean
}

interface TreeCategory {
  name: string
  repos: TreeRepo[]
  expanded: boolean
}

const props = defineProps<{
  categories: TreeCategory[]
  selectedPrId: string | null
}>()

const emit = defineEmits<{
  (e: 'toggle-category', name: string): void
  (e: 'toggle-repo', repoName: string): void
  (e: 'select-pr', repo: string, prNumber: number): void
}>()

function prId(repo: string, prNumber: number): string {
  return `${repo}#${prNumber}`
}

function statusLabel(status: PrStatus): string {
  switch (status) {
    case 'passing': return 'Passing'
    case 'failing': return 'Failing'
    case 'outdated': return 'Outdated'
  }
}

function statusColor(status: PrStatus): string {
  switch (status) {
    case 'passing': return '#00703c'
    case 'failing': return '#d4351c'
    case 'outdated': return '#f47738'
  }
}

function categoryPrCount(cat: TreeCategory): number {
  return cat.repos.reduce((sum, r) => sum + r.prs.length, 0)
}

function repoPrCount(repo: TreeRepo): number {
  return repo.prs.length
}

// ── Filter ──────────────────────────────────────────────────────────
const filterText = ref('')

const filteredCategories = computed(() => {
  const query = filterText.value.toLowerCase().trim()

  return props.categories
    .map((cat) => {
      const filteredRepos = cat.repos.filter((repo) => {
        // If filter is active, match repo name or PR titles
        if (query) {
          const repoMatches = repo.name.toLowerCase().includes(query)
          const prMatches = repo.prs.some((pr) => pr.title.toLowerCase().includes(query))
          return repoMatches || prMatches
        }
        // No filter: only show repos that have PRs or errors
        return repo.prs.length > 0 || repo.error
      })
      return { ...cat, repos: filteredRepos }
    })
    .filter((cat) => cat.repos.length > 0)
})
</script>

<template>
  <nav class="tree" aria-label="Dependabot PR navigation">
    <!-- Filter input -->
    <div class="tree__filter">
      <svg class="tree__filter-icon" aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="#b1b4b6">
        <path d="M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Zm-1.06 3.55a6 6 0 1 1 1.06-1.06l3.76 3.76a.75.75 0 1 1-1.06 1.06l-3.76-3.76Z"/>
      </svg>
      <input
        v-model="filterText"
        class="tree__filter-input"
        type="text"
        placeholder="Filter repos…"
        spellcheck="false"
        autocomplete="off"
      />
      <button v-if="filterText" class="tree__filter-clear" @click="filterText = ''" aria-label="Clear filter">×</button>
    </div>

    <!-- Tree body -->
    <div class="tree__body">
      <div v-if="filteredCategories.length === 0" class="tree__empty">
        No matching repos found.
      </div>

      <div v-for="cat in filteredCategories" :key="cat.name" class="tree__category">
        <!-- Category header -->
        <button class="tree__cat-btn" @click="emit('toggle-category', cat.name)">
          <svg class="tree__chevron" :class="{ 'tree__chevron--open': cat.expanded }" width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
            <path d="M3 1.5l4 3.5-4 3.5z"/>
          </svg>
          <span class="tree__cat-label">{{ cat.name }}</span>
          <span v-if="categoryPrCount(cat)" class="tree__cat-count">{{ categoryPrCount(cat) }}</span>
        </button>

        <!-- Repos -->
        <div v-if="cat.expanded" class="tree__repos">
          <div v-for="repo in cat.repos" :key="repo.name" class="tree__repo">
            <!-- Repo header -->
            <button class="tree__repo-btn" @click="emit('toggle-repo', repo.name)">
              <svg class="tree__chevron tree__chevron--sm" :class="{ 'tree__chevron--open': repo.expanded }" width="8" height="8" viewBox="0 0 10 10" fill="currentColor">
                <path d="M3 1.5l4 3.5-4 3.5z"/>
              </svg>
              <span class="tree__repo-name">{{ repo.name }}</span>
              <span class="tree__repo-meta">
                <span v-if="repo.error" class="tree__error-badge">!</span>
                <span v-else-if="repoPrCount(repo)" class="tree__repo-count">{{ repoPrCount(repo) }}</span>
              </span>
            </button>

            <!-- PRs -->
            <div v-if="repo.expanded && repo.prs.length" class="tree__prs">
              <button
                v-for="pr in repo.prs"
                :key="pr.number"
                class="tree__pr"
                :class="{ 'tree__pr--active': selectedPrId === prId(repo.name, pr.number) }"
                @click="emit('select-pr', repo.name, pr.number)"
              >
                <span class="tree__pr-dot" :style="{ background: statusColor(pr.status) }" :title="statusLabel(pr.status)"></span>
                <span class="tree__pr-title">
                  <span class="tree__pr-num">#{{ pr.number }}</span>
                  {{ pr.title }}
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </nav>
</template>

<style scoped>
.tree {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #fafafa;
}

/* ── Filter ──────────────────────────────────────────────────────── */
.tree__filter {
  position: relative;
  padding: 10px 12px;
  border-bottom: 1px solid #f0f0f0;
  flex-shrink: 0;
}

.tree__filter-icon {
  position: absolute;
  left: 22px;
  top: 50%;
  transform: translateY(-50%);
  pointer-events: none;
}

.tree__filter-input {
  width: 100%;
  padding: 7px 28px 7px 32px;
  border: 1px solid #e5e5e5;
  border-radius: 6px;
  font-size: 0.78rem;
  background: #fff;
  color: #0b0c0c;
  box-sizing: border-box;
  transition: border-color 0.15s;
}

.tree__filter-input:focus {
  outline: none;
  border-color: #1d70b8;
  box-shadow: 0 0 0 2px rgba(29,112,184,0.15);
}

.tree__filter-input::placeholder {
  color: #b1b4b6;
}

.tree__filter-clear {
  position: absolute;
  right: 20px;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  cursor: pointer;
  font-size: 1.1rem;
  color: #505a5f;
  padding: 0;
  line-height: 1;
}

.tree__filter-clear:hover {
  color: #0b0c0c;
}

/* ── Body ────────────────────────────────────────────────────────── */
.tree__body {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.tree__empty {
  padding: 20px 16px;
  font-size: 0.8rem;
  color: #505a5f;
  text-align: center;
}

/* ── Category ────────────────────────────────────────────────────── */
.tree__category {
  margin: 0;
}

.tree__cat-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 7px 12px;
  border: none;
  background: none;
  cursor: pointer;
  font-family: inherit;
  font-size: 0.78rem;
  font-weight: 600;
  color: #505a5f;
  text-align: left;
}

.tree__cat-btn:hover {
  background: #f0f4f8;
}

.tree__cat-label {
  flex: 1;
}

.tree__cat-count {
  font-size: 0.68rem;
  font-weight: 600;
  background: #e8e8e8;
  color: #505a5f;
  padding: 1px 6px;
  border-radius: 8px;
  min-width: 16px;
  text-align: center;
}

/* ── Chevron ─────────────────────────────────────────────────────── */
.tree__chevron {
  flex-shrink: 0;
  color: #b1b4b6;
  transition: transform 0.15s ease;
}

.tree__chevron--open {
  transform: rotate(90deg);
}

.tree__chevron--sm {
  width: 8px;
  height: 8px;
}

/* ── Repos ───────────────────────────────────────────────────────── */
.tree__repos {
  padding: 0;
}

.tree__repo {
  margin: 0;
}

.tree__repo-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  padding: 5px 12px 5px 24px;
  border: none;
  background: none;
  cursor: pointer;
  font-family: inherit;
  font-size: 0.76rem;
  font-weight: 500;
  color: #0b0c0c;
  text-align: left;
}

.tree__repo-btn:hover {
  background: #f0f4f8;
}

.tree__repo-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tree__repo-meta {
  flex-shrink: 0;
}

.tree__error-badge {
  font-size: 0.62rem;
  font-weight: 700;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #d4351c;
  color: #fff;
}

.tree__repo-count {
  font-size: 0.68rem;
  font-weight: 600;
  color: #808080;
}

/* ── PRs ─────────────────────────────────────────────────────────── */
.tree__prs {
  padding: 0;
}

.tree__pr {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 5px 12px 5px 40px;
  border: none;
  border-left: 3px solid transparent;
  background: none;
  cursor: pointer;
  font-family: inherit;
  text-align: left;
  transition: background 0.1s;
}

.tree__pr:hover {
  background: #f0f4f8;
}

.tree__pr--active {
  background: #edf4fc;
  border-left-color: #1d70b8;
}

.tree__pr-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.tree__pr-title {
  font-size: 0.74rem;
  color: #0b0c0c;
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.tree__pr-num {
  font-family: monospace;
  color: #808080;
  font-size: 0.7rem;
  margin-right: 3px;
}
</style>
