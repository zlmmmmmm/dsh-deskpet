'use strict';
/**
 * 渲染进程入口：取初始化载荷 → 造宠物 → 开跑
 * 刻意保持极薄：宠物逻辑全在 pet.js，进程能力全在 preload.js 的白名单里。
 */
(async function () {
  const payload = await window.deskpet.ready();
  if (!payload) {
    console.error('[deskpet] 拿不到初始化载荷（deskpet:ready 返回空）');
    return;
  }

  const pet = new window.DeskPet.PetSprite(payload);
  pet.attachInput();
  pet.start();

  // 坐标系自检：window.screenX/Y 必须与主进程 getBounds() 同口径（都是 DIP）。
  // 主进程会打出自己的 bounds，两边对不上就说明发生了 DPI 虚拟化，需要在这里补偿。
  console.log(
    `[deskpet] diag screenXY=${window.screenX},${window.screenY} ` +
      `dpr=${window.devicePixelRatio} inner=${window.innerWidth}x${window.innerHeight} ` +
      `geom=${payload.geom.w}x${payload.geom.h} pos=${payload.pos.x},${payload.pos.y}`,
  );

  window.__deskpet = pet; // 便于调试
})();
