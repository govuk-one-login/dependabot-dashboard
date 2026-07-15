<script setup lang="ts">
import GovukHeader from './components/GovukHeader.vue'
import GovukFooter from './components/GovukFooter.vue'
import GovukPhaseBanner from './components/GovukPhaseBanner.vue'
</script>

<template>
  <a href="#main-content" class="govuk-skip-link" data-module="govuk-skip-link">
    Skip to main content
  </a>

  <GovukHeader />

  <div class="app-content-area">
    <div class="app-container">
      <GovukPhaseBanner />
      
      <main class="app-main" id="main-content">
        <router-view />
      </main>
    </div>
  </div>

  <GovukFooter />
</template>

<style scoped>
.app-content-area {
  flex: 1 0 auto;
  background: #ffffff;
}

.app-container {
  max-width: 1100px;
  margin: 0 auto;
  padding: 0 30px;
}

.app-main {
  padding: 40px 0 80px;
}
</style>
