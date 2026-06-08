<template>
  <div v-if="showSponsorModal" class="sp-mask" @click.self="close">
    <div class="sp-card">
      <div class="sp-title">感谢使用踏海</div>
      <div class="sp-body">
        您的本月额度已经用尽，等待下个月一号额度刷新，或者您可以选择支持我们获取额度
      </div>
      <a class="sp-btn" :href="AFDIAN_URL" target="_blank" rel="noreferrer">支持我们 →</a>
      <div class="sp-close" @click="close">关闭</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { showSponsorModal, AFDIAN_URL } from "../logic/auth";

function close() {
  showSponsorModal.value = false;
}
</script>

<style scoped>
.sp-mask {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(4px);
}

.sp-card {
  width: 380px;
  max-width: 88vw;
  padding: 28px 26px 20px;
  border-radius: 18px;
  background: rgba(28, 24, 18, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.08);
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.5);
  color: wheat;
  text-align: center;
  font-family: "ZhuoKai", system-ui, sans-serif;
}

.sp-title {
  font-size: 22px;
  margin-bottom: 14px;
}

.sp-body {
  font-size: 15px;
  line-height: 1.7;
  color: rgba(255, 255, 255, 0.82);
  margin-bottom: 22px;
}

.sp-btn {
  display: inline-block;
  padding: 10px 28px;
  border-radius: 10px;
  background: wheat;
  color: #1c1812;
  font-size: 16px;
  text-decoration: none;
  transition: transform 0.15s, box-shadow 0.15s;
}

.sp-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 20px rgba(245, 222, 179, 0.35);
}

.sp-close {
  margin-top: 16px;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.5);
  cursor: pointer;
  user-select: none;
}

.sp-close:hover {
  color: rgba(255, 255, 255, 0.85);
}
</style>
