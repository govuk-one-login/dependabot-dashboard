<script setup lang="ts">
import { computed } from 'vue'
import { html as diff2html } from 'diff2html'

const props = defineProps<{
  rawDiff: string
}>()

const renderedHtml = computed(() => {
  if (!props.rawDiff) return ''
  return diff2html(props.rawDiff, {
    drawFileList: false,
    matching: 'lines',
    outputFormat: 'side-by-side',
  })
})
</script>

<template>
  <div class="diff-viewer" v-html="renderedHtml"></div>
</template>

<style scoped>
.diff-viewer {
  max-height: 520px;
  overflow: auto;
  font-size: 0.8rem;
  border-top: 1px solid #b1b4b6;
}

.diff-viewer :deep(.d2h-file-side-diff) {
  position: relative;
}

.diff-viewer :deep(.d2h-wrapper) {
  border: none;
}

.diff-viewer :deep(.d2h-file-header) {
  background: #f3f2f1;
  border-bottom: 1px solid #b1b4b6;
  padding: 6px 12px;
  font-size: 0.78rem;
  font-weight: 600;
}

.diff-viewer :deep(.d2h-code-line-ctn) {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 0.78rem;
}

.diff-viewer :deep(.d2h-del) {
  background-color: #ffeef0;
}

.diff-viewer :deep(.d2h-ins) {
  background-color: #e6ffec;
}

.diff-viewer :deep(.d2h-code-side-line.d2h-del) {
  background-color: #ffeef0;
}

.diff-viewer :deep(.d2h-code-side-line.d2h-ins) {
  background-color: #e6ffec;
}
</style>
