<template>
  <div class="glass2 glass2-nav">
    <slot/>
  </div>
</template>

<style>
.glass2 {
  display: flex;
  padding: 22px;
  color: var(--text-primary);
  font-family: "ZhuoKai", system-ui, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
  background: rgba(4, 4, 2, 0.84);
  backdrop-filter: blur(22px) saturate(94%);
  -webkit-backdrop-filter: blur(22px) saturate(94%);
  border: 1px solid rgba(209, 200, 182, 0.16);
  border-top-color: rgba(244, 241, 236, 0.22);
  border-radius: 8px;
  box-shadow: inset 0 1px 0 rgba(244, 241, 236, 0.045), 0 18px 48px rgba(0, 0, 0, 0.32);
  max-width: 1500px;
}

.glass2-nav {
  position: fixed;
  top: 20px;
  left: 50%;
  right: auto;
  width: min(calc(100vw - 40px), 1600px);
  max-width: 1600px;
  height: 76px;
  z-index: 20;
  align-items: center;
  margin: 0;
  padding: 12px 28px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  column-gap: 24px;
  transform: translateX(-50%);
  isolation: isolate;
  overflow: visible;
  background: transparent;
  backdrop-filter: blur(32px) saturate(92%);
  -webkit-backdrop-filter: blur(32px) saturate(92%);
  border-color: rgba(209, 200, 182, 0.16);
  border-top-color: rgba(244, 241, 236, 0.26);
  border-bottom-color: rgba(209, 200, 182, 0.09);
  border-radius: 18px;
  box-shadow:
    inset 0 1px 0 rgba(244, 241, 236, 0.08),
    inset 0 -1px 0 rgba(0, 0, 0, 0.3),
    0 12px 36px rgba(0, 0, 0, 0.16);
}

.glass2-nav::before {
  content: "";
  position: absolute;
  top: 1px;
  right: 22px;
  left: 22px;
  height: 1px;
  pointer-events: none;
  background: linear-gradient(90deg, transparent, rgba(244, 241, 236, 0.18), transparent);
}

.header {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  height: 100%;
  justify-self: start;
  box-sizing: border-box;
  user-select: none;
  cursor: pointer;
}

.header-icon {
  width: 44px;
  height: 44px;
  object-fit: contain;
}

.center {
  display: flex;
  align-items: center;
  justify-content: center;
  justify-self: center;
  height: 100%;
  min-width: 0;
  color: #d1c8b6;
  user-select: none;
}

.right {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  justify-self: end;
  min-width: 0;
  height: 100%;
  gap: 24px;
  color: rgba(209, 200, 182, 0.52);
}

.link {
  color: rgba(209, 200, 182, 0.52);
  cursor: pointer;
  user-select: none;
  text-decoration: none;
  transition: color 0.16s ease;
}

.link:hover {
  color: #f4f1ec;
}

@media (max-width: 820px) {
  .glass2-nav {
    top: 10px;
    left: 50%;
    right: auto;
    width: calc(100vw - 20px);
    height: 64px;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    column-gap: 8px;
    padding: 8px 12px;
    border-radius: 16px;
  }

  .header-title, .right .link:not(:first-child) { display: none; }
  .right { gap: 8px; }
  .header-icon { width: 36px; height: 36px; }
}

</style>
