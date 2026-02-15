<template>
  <div class="glass2">
    <slot/>
  </div>
</template>

<style>
.glass2 {
  display: flex;
  position: fixed;
  top: 20px;
  left: 16px;
  right: 16px;
  height: 32px;
  padding: 22px;
  color: wheat;
  background: rgba(255, 255, 255, 0.02);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border-radius: 22px;
  border: 3px solid rgba(255, 255, 255, 0.03);
}

.header {
  display: flex;
  font-size: 32px;
  align-items: center;
  justify-content: space-between;
  box-sizing: border-box;
  user-select: none;
}

.center {
  display: flex;
  font-size: 24px;
  justify-content: center;
  flex: 1; /* 中间占剩余空间 */
  min-width: 0;
  color: white;
  text-shadow:
      0 0 8px rgba(255,255,255,0.25),
      0 0 18px rgba(255,255,255,0.12);
  user-select: none;
}

.right {
  display: flex;
  align-items: center;
  justify-content: end;
  text-shadow: 0 1px 8px rgba(0,0,0,.35);
  gap : 24px;
  color: white;
}

.link {
  color: white;
  opacity: 0.9;
  cursor: pointer;
  user-select: none;
  text-decoration: none;
}

.link:hover{
  opacity: 1;
  text-shadow:
      0 0 8px rgba(255,255,255,0.35),
      0 0 18px rgba(255,255,255,0.22);
}

</style>
