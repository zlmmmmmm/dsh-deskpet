'use strict';
/**
 * 宠物精灵：位置 / 动画 / 拖拽抛掷 / 漫游 / 气泡
 * ============================================================================
 * 设计要点
 *   1. **窗口永远跟着精灵走**，精灵在窗口内的位置恒定 → 命中区是常量，
 *      主进程不需要逐帧同步命中区（省掉一整条 IPC 通道）。
 *   2. 拖动用「光标屏幕坐标之差」定位窗口，而不是绝对屏幕坐标：
 *      grab 偏移 = e.screenX - window.screenX，两者出自同一坐标系，
 *      所以无论它是 DIP 还是物理像素，换算都自洽（不会出现 1.5 倍漂移）。
 *   3. 所有动画都是**程序化**的（呼吸 / 摇摆 / 挤压 / 拉伸），不依赖序列帧素材：
 *      用户目前只有两张静态原型图，先用变换把「活着」的感觉做出来。
 */
(function () {
  'use strict';

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const rand = (a, b) => a + Math.random() * (b - a);
  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const DRAG_THRESHOLD = 6; // px：位移超过它才算拖拽，否则算点击
  const CLICK_REACT_SEC = 0.45;
  const BUBBLE_DEFAULT_MS = 6000;
  const BREATH_PERIOD = 3.2; // 秒
  const THROW_MIN_SPEED = 380; // px/s：低于它视为「温柔放下」

  // ========================================================== 动作片段 ====
  /**
   * 全部是**程序化**动作：我们手上只有静态形象图，没有序列帧/视频素材。
   * 每个片段是 `(t, size, dur) => 形变增量`，返回：
   *   dx/dy  位移（px）
   *   sx/sy  缩放增量（乘在呼吸/挤压之上）
   *   rot    旋转（度）
   * 坐标系原点在精灵底边中心（transform-origin: 50% 100%），所以"蹦"看起来像跳起来。
   */
  const CLIPS = {
    // ---- 工作状态：循环片段，直到宿主把 level 清成 null ----
    /** 0 思考：轻微左右歪头 */
    thinking: {
      loop: true,
      dur: 2.6,
      f: (t, size) => ({ dy: Math.sin(t * 1.7) * size * 0.008, rot: Math.sin(t * 1.7) * 3.5 }),
    },
    /** 1 干活：小幅快速上下点 */
    working: {
      loop: true,
      dur: 1.1,
      f: (t, size) => {
        const k = Math.abs(Math.sin(t * 5.2));
        return { dy: -k * size * 0.028, sy: 1 + k * 0.03, sx: 1 - k * 0.02 };
      },
    },
    /** 2 单步完成：轻轻点头 */
    result: {
      loop: true,
      dur: 1.6,
      f: (t, size) => ({ dy: Math.sin(t * 3.4) * size * 0.007, rot: Math.sin(t * 2.2) * 2 }),
    },
    /** 3 等你确认：周期性蹦起来招手，最显眼的一档 */
    waiting: {
      loop: true,
      dur: 1.8,
      f: (t, size) => {
        const x = (t % 1.8) / 1.8;
        const hop = x < 0.5 ? Math.sin((x / 0.5) * Math.PI) : 0;
        return {
          dy: -hop * size * 0.1,
          sy: 1 - hop * 0.06,
          sx: 1 + hop * 0.05,
          rot: hop * 6,
        };
      },
    },
    // ---- 终态：一次性，演完回待机 ----
    /** 4 全部完成：两连跳 + 落地挤压 */
    success: {
      loop: false,
      dur: 1.7,
      f: (t, size, dur) => {
        const x = Math.min(1, t / dur);
        const hop = Math.max(0, Math.sin(x * Math.PI * 2)) * (1 - x * 0.35);
        const land = Math.max(0, Math.sin(x * Math.PI * 4)) * 0.4;
        return {
          dy: -hop * size * 0.14,
          sy: 1 - land * 0.24 + hop * 0.08,
          sx: 1 + land * 0.18 - hop * 0.05,
        };
      },
    },
    /** 5 出错：抖一下然后垮下来 */
    error: {
      loop: false,
      dur: 1.3,
      f: (t, size, dur) => {
        const x = Math.min(1, t / dur);
        const shake = Math.sin(t * 34) * Math.exp(-x * 3.2);
        const slump = Math.exp(-x * 2.2);
        return { dx: shake * size * 0.035, rot: shake * 4, sy: 1 - 0.12 * slump, sx: 1 + 0.08 * slump };
      },
    },
    // ---- 提醒（一次性，优先级高于工作状态片段）----
    /** 干完了：跳起来庆祝 */
    notice_done: {
      loop: false,
      dur: 2.0,
      f: (t, size, dur) => {
        const x = Math.min(1, t / dur);
        const hop = Math.abs(Math.sin(x * Math.PI * 3)) * (1 - x * 0.3);
        return { dy: -hop * size * 0.16, sy: 1 + hop * 0.09, sx: 1 - hop * 0.06 };
      },
    },
    /** 要你确认 / 有问题：连着蹦，配上气泡足够引起注意 */
    notice_attention: {
      loop: false,
      dur: 2.4,
      f: (t, size, dur) => {
        const x = Math.min(1, t / dur);
        const hop = Math.abs(Math.sin(x * Math.PI * 4)) * (1 - x * 0.25);
        return { dy: -hop * size * 0.13, rot: Math.sin(t * 9) * 5 * (1 - x), sy: 1 + hop * 0.06, sx: 1 - hop * 0.04 };
      },
    },
    /** 出错：急抖 + 快速下沉 */
    notice_error: {
      loop: false,
      dur: 1.8,
      f: (t, size, dur) => {
        const x = Math.min(1, t / dur);
        const shake = Math.sin(t * 38) * Math.exp(-x * 2.6);
        const slump = Math.exp(-x * 1.8);
        return { dx: shake * size * 0.045, rot: shake * 5, sy: 1 - 0.14 * slump, sx: 1 + 0.1 * slump };
      },
    },
  };

  /** 工作状态档位 → 气泡配色 */
  const LEVEL_STYLE = {
    thinking: 'info',
    working: 'info',
    result: 'info',
    waiting: 'attention',
    success: 'success',
    error: 'error',
  };

  /** 提醒类型 → 动作片段 */
  const NOTICE_CLIP = {
    done: 'notice_done',
    error: 'notice_error',
    truncated: 'notice_error',
    approval: 'notice_attention',
    question: 'notice_attention',
  };

  /**
   * 形象素材 → 可加载的 URL。
   * 正式运行时宿主给的是绝对路径；本地开发（不经过 DSH）给的是 `<id>/idle.png` 相对路径。
   * file:// 页面加载 file:// 图片是允许的（img 不受 file 同源限制），CSP 里也显式放行了 file:。
   */
  function assetUrl(species) {
    const file = typeof species.file === 'string' ? species.file : '';
    if (!file) return `../../assets/pet/${species.id}/idle.png`;
    if (/^[a-zA-Z]:[\\/]/.test(file) || file.startsWith('\\\\')) {
      return `file:///${file.replace(/\\/g, '/')}`;
    }
    if (file.startsWith('/')) return `file://${file}`;
    return `../../assets/pet/${file}`;
  }

  class PetSprite {
    constructor(payload) {
      const { pet, species, geom, area, pos, config } = payload;
      this.pet = pet;
      this.species = species;
      this.geom = geom;
      this.area = area;
      this.cfg = config;

      this.bounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
      this.recomputeBounds();

      this.pos = { x: pos.x, y: pos.y };
      this.vel = { x: 0, y: 0 };
      this.mode = 'idle'; // idle | walk | drag | fly
      this.t = 0;
      this.last = 0;
      this.reactLeft = 0;
      this.landSquash = 0;
      this.bob = 0;
      this.facing = 1;
      this.hovered = false;
      this.roamWait = rand(this.cfg.roam.pauseMinSec, this.cfg.roam.pauseMaxSec);
      this.walkTargetX = null;
      this.drag = null;
      this.samples = [];
      this.bubbleTimer = null;
      this.sentX = null;
      this.sentY = null;
      /** 当前工作状态片段名（循环） */
      this.statusClip = null;
      /** 一次性动作片段 { name, t }（提醒/终态，优先级高于 statusClip） */
      this.oneShot = null;

      this.root = document.getElementById('pet-root');
      this.img = document.getElementById('sprite');
      this.bubble = document.getElementById('bubble');
      this.bubbleText = document.getElementById('bubble-text');

      this.applyLayout();
    }

    // ------------------------------------------------------------- 初始化 --
    /** 精灵矩形的合法窗口位置范围（约束的是精灵，不是窗口） */
    recomputeBounds() {
      const { area, geom } = this;
      this.bounds = {
        minX: area.x - geom.padX,
        maxX: area.x + area.width - geom.w + geom.padX,
        minY: area.y - geom.padTop,
        maxY: area.y + area.height - geom.h + geom.padTop,
      };
    }

    applyLayout() {
      const { geom, species } = this;
      const s = this.root.style;
      s.left = `${geom.sprite.x}px`;
      s.top = `${geom.sprite.y}px`;
      s.width = `${geom.sprite.w}px`;
      s.height = `${geom.sprite.h}px`;
      document.documentElement.style.setProperty('--pet-size', `${this.pet.size}px`);

      this.root.style.background = 'transparent';
      this.img.src = assetUrl(species);
      this.img.onerror = () => {
        // 素材缺失必须大声报错，并在窗口里留一个可见的占位块（绝不静默留白）
        console.error(`[deskpet] 找不到素材：${species.file || species.id}`);
        this.root.style.background = 'rgba(90, 150, 230, 0.5)';
        this.root.style.borderRadius = '20px';
      };
    }

    /** 切换形象：换图 + 换几何（窗口尺寸由主进程改，这里只跟着重排） */
    applySpecies({ species, geom, area, pos }) {
      this.species = species;
      this.geom = geom;
      if (area) this.area = area;
      this.recomputeBounds();
      this.applyLayout();
      if (pos) {
        this.pos = { x: pos.x, y: pos.y };
        this.sentX = null;
        this.sentY = null;
      }
      this.vel = { x: 0, y: 0 };
      this.mode = 'idle';
    }

    attachInput() {
      document.addEventListener('pointerdown', (e) => this.onDown(e));
      document.addEventListener('pointermove', (e) => this.onMove(e));
      document.addEventListener('pointerup', (e) => this.onUp(e));
      document.addEventListener('pointercancel', (e) => this.onUp(e));
      document.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.lockInput(true);
        window.deskpet.openMenu({ x: e.clientX, y: e.clientY });
        setTimeout(() => this.lockInput(false), 500);
      });

      window.deskpet.onHover((inside) => {
        this.hovered = inside;
        document.body.style.cursor = inside ? 'grab' : 'default';
      });
      window.deskpet.onHome((p) => {
        this.pos = { x: p.x, y: p.y };
        this.vel = { x: 0, y: 0 };
        this.mode = 'idle';
        this.syncWindow(true);
      });
      window.deskpet.onPush((msg) => this.onPush(msg));
      window.deskpet.onSpecies((payload) => this.applySpecies(payload));
    }

    lockInput(locked) {
      window.deskpet.lockInput(locked);
    }

    // -------------------------------------------------------------- 主循环 --
    start() {
      requestAnimationFrame(this.frame);
    }

    frame = (now) => {
      const dt = this.last ? Math.min(0.05, (now - this.last) / 1000) : 0.016;
      this.last = now;
      this.t += dt;

      if (this.mode === 'fly') this.stepFly(dt);
      else if (this.mode === 'walk') this.stepWalk(dt);
      else if (this.mode !== 'drag') this.stepIdle(dt);

      if (this.landSquash > 0) this.landSquash = Math.max(0, this.landSquash - dt * 3.2);
      if (this.reactLeft > 0) this.reactLeft = Math.max(0, this.reactLeft - dt);
      if (this.oneShot) {
        this.oneShot.t += dt;
        const spec = CLIPS[this.oneShot.name];
        if (!spec || this.oneShot.t >= spec.dur) this.oneShot = null;
      }

      this.paint();
      this.syncWindow(false);
      requestAnimationFrame(this.frame);
    };

    syncWindow(force) {
      const x = Math.round(this.pos.x);
      const y = Math.round(this.pos.y);
      if (!force && x === this.sentX && y === this.sentY) return;
      this.sentX = x;
      this.sentY = y;
      window.deskpet.moveWindow(x, y);
    }

    // ----------------------------------------------------------- 待机/漫游 --
    stepIdle(dt) {
      this.bob = 0;
      if (!this.cfg.roamEnabled || this.hovered || this.drag) return;
      this.roamWait -= dt;
      if (this.roamWait <= 0) this.beginWalk();
    }

    beginWalk() {
      const r = this.cfg.roam;
      const dist = rand(r.minDist, r.maxDist) * (Math.random() < 0.5 ? -1 : 1);
      const target = clamp(this.pos.x + dist, this.bounds.minX, this.bounds.maxX);
      if (Math.abs(target - this.pos.x) < 12) {
        this.roamWait = rand(r.pauseMinSec, r.pauseMaxSec);
        return;
      }
      this.walkTargetX = target;
      this.mode = 'walk';
    }

    stepWalk(dt) {
      const dir = Math.sign(this.walkTargetX - this.pos.x) || 1;
      this.facing = dir;
      this.pos.x += dir * this.cfg.roam.speed * dt;
      this.bob = Math.abs(Math.sin(this.t * 9)) * this.geom.size * 0.035;

      const arrived = dir > 0 ? this.pos.x >= this.walkTargetX : this.pos.x <= this.walkTargetX;
      if (arrived) {
        this.pos.x = this.walkTargetX;
        this.walkTargetX = null;
        this.bob = 0;
        this.mode = 'idle';
        this.roamWait = rand(this.cfg.roam.pauseMinSec, this.cfg.roam.pauseMaxSec);
      }
    }

    // ------------------------------------------------------------ 抛掷物理 --
    stepFly(dt) {
      const ph = this.cfg.physics;
      const b = this.bounds;

      this.vel.y += ph.gravity * dt;
      this.pos.x += this.vel.x * dt;
      this.pos.y += this.vel.y * dt;

      if (this.pos.x < b.minX) {
        this.pos.x = b.minX;
        this.vel.x = Math.abs(this.vel.x) * ph.restitution;
        this.facing = 1;
      } else if (this.pos.x > b.maxX) {
        this.pos.x = b.maxX;
        this.vel.x = -Math.abs(this.vel.x) * ph.restitution;
        this.facing = -1;
      }
      if (this.pos.y < b.minY) {
        this.pos.y = b.minY;
        this.vel.y = Math.abs(this.vel.y) * ph.restitution;
      }

      if (this.pos.y >= b.maxY) {
        this.pos.y = b.maxY;
        if (this.vel.y > 260) {
          // 砸地：按冲击速度做一次 Q 弹，再反弹
          this.landSquash = clamp(this.vel.y / 2600, 0.12, 0.7);
          this.vel.y = -this.vel.y * ph.restitution;
        } else {
          this.vel.y = 0;
        }
        this.vel.x *= Math.exp(-ph.groundFriction * dt);
      }

      if (this.pos.y >= b.maxY - 0.5 && Math.abs(this.vel.x) < 24 && Math.abs(this.vel.y) < 40) {
        this.vel.x = 0;
        this.vel.y = 0;
        this.mode = 'idle';
        this.roamWait = rand(this.cfg.roam.pauseMinSec, this.cfg.roam.pauseMaxSec);
      }
    }

    // ---------------------------------------------------------------- 输入 --
    onDown(e) {
      if (e.button !== 0) return;
      this.lockInput(true);
      this.drag = {
        startX: e.screenX,
        startY: e.screenY,
        winX: window.screenX, // 与 e.screenX 同一坐标系
        winY: window.screenY,
        originX: this.pos.x,
        originY: this.pos.y,
        moved: 0,
      };
      this.samples = [{ t: performance.now(), x: e.screenX, y: e.screenY }];
      this.mode = 'drag';
      this.root.classList.add('dragging');
      try {
        this.root.setPointerCapture(e.pointerId);
      } catch {
        /* 捕获失败不影响：窗口会跟着光标走 */
      }
    }

    onMove(e) {
      if (!this.drag) return;
      const d = this.drag;
      // 光标在窗口内的位置（同一坐标系相减，绕开 DIP/物理像素口径问题）
      const grabX = d.startX - d.winX;
      const grabY = d.startY - d.winY;
      const nx = e.screenX - grabX;
      const ny = e.screenY - grabY;

      d.moved = Math.max(d.moved, Math.hypot(nx - d.originX, ny - d.originY));
      this.pos.x = nx;
      this.pos.y = ny;

      const now = performance.now();
      this.samples.push({ t: now, x: e.screenX, y: e.screenY });
      while (this.samples.length > 2 && now - this.samples[0].t > 140) this.samples.shift();
    }

    onUp() {
      if (!this.drag) return;
      const d = this.drag;
      this.drag = null;
      this.root.classList.remove('dragging');
      this.lockInput(false);

      if (d.moved < DRAG_THRESHOLD) {
        // 点击：挤压回应 + 把 DSH 叫回来
        this.reactLeft = REDUCED ? 0 : CLICK_REACT_SEC;
        if (this.cfg.clickToFocusDsh) window.deskpet.focusDsh();
        this.mode = 'idle';
        return;
      }

      const v = this.estimateVelocity();
      const power = this.cfg.physics.throwPower;
      const speed = Math.hypot(v.x, v.y) * power;
      if (speed > THROW_MIN_SPEED) {
        this.vel = { x: v.x * power, y: v.y * power };
        this.grounded = false;
        this.mode = 'fly';
      } else {
        // 停顿/慢速 = 温柔放下：原地停住，只做一次轻微下沉
        this.vel = { x: 0, y: 0 };
        this.landSquash = 0.35;
        this.mode = 'idle';
      }
      this.roamWait = rand(this.cfg.roam.pauseMinSec, this.cfg.roam.pauseMaxSec);
    }

    /** 用最近 140ms 的轨迹估速（松手瞬间的速度） */
    estimateVelocity() {
      const s = this.samples;
      if (s.length < 2) return { x: 0, y: 0 };
      const last = s[s.length - 1];
      let first = s[0];
      for (let i = s.length - 1; i >= 0; i--) {
        if (last.t - s[i].t <= 140) first = s[i];
        else break;
      }
      const dt = Math.max(0.016, (last.t - first.t) / 1000);
      return { x: (last.x - first.x) / dt, y: (last.y - first.y) / dt };
    }

    // ---------------------------------------------------------------- 绘制 --
    paint() {
      const phase = this.t * ((2 * Math.PI) / BREATH_PERIOD);
      const breath = REDUCED ? 0 : Math.sin(phase) * 0.018;
      let sx = 1 - breath * 0.6;
      let sy = 1 + breath;
      let dx = 0;
      let dy = this.bob;
      let rot = 0;

      // 动作片段：拖拽/被甩飞时让位给物理，不然会打架
      const clipName = this.oneShot ? this.oneShot.name : this.statusClip;
      if (clipName && !REDUCED && this.mode !== 'drag' && this.mode !== 'fly') {
        const spec = CLIPS[clipName];
        if (spec) {
          // 循环片段用全局时间（相位连续），一次性片段用它自己的时间
          const tv = this.oneShot ? this.oneShot.t : this.t;
          const r = spec.f(tv, this.geom.size, spec.dur) || {};
          dx += r.dx ?? 0;
          dy += r.dy ?? 0;
          sx *= r.sx ?? 1;
          sy *= r.sy ?? 1;
          rot += r.rot ?? 0;
        }
      }

      if (this.reactLeft > 0) {
        const p = 1 - this.reactLeft / CLICK_REACT_SEC;
        const k = Math.sin(clamp(p, 0, 1) * Math.PI) * 0.85;
        sy *= 1 - k * 0.3;
        sx *= 1 + k * 0.22;
      }
      if (this.landSquash > 0) {
        sy *= 1 - this.landSquash * 0.32;
        sx *= 1 + this.landSquash * 0.2;
      }
      if (this.mode === 'fly') {
        const stretch = clamp(this.vel.y / 4200, -0.18, 0.18);
        sy *= 1 + stretch;
        sx *= 1 - stretch * 0.6;
      }

      const parts = [`translate3d(${dx.toFixed(2)}px, ${dy.toFixed(2)}px, 0)`];
      if (rot) parts.push(`rotate(${rot.toFixed(2)}deg)`);
      parts.push(`scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`);
      this.root.style.transform = parts.join(' ');
      this.img.style.transform = `scaleX(${this.facing})`;
    }

    // ---------------------------------------------------------------- 气泡 --
    /**
     * @param {string} text
     * @param {{ms?: number, level?: 'info'|'success'|'attention'|'error'}} [opts]
     */
    showBubble(text, opts = {}) {
      const ms = opts.ms ?? BUBBLE_DEFAULT_MS;
      const level = opts.level ?? 'info';
      this.bubbleText.textContent = text;
      this.bubble.className = `show ${level}`;
      if (this.bubbleTimer) clearTimeout(this.bubbleTimer);
      this.bubbleTimer = setTimeout(() => {
        this.bubble.className = level;
      }, ms);
    }

    /** 宿主推送：提醒 / 工作状态 / 普通气泡，DSH 侧的联动全从这里进来 */
    onPush(msg) {
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'bubble') {
        this.showBubble(String(msg.text ?? ''), { ms: msg.ms, level: msg.level });
        return;
      }

      if (msg.type === 'workStatus') {
        const level = msg.level ? String(msg.level) : null;
        const spec = level ? CLIPS[level] : null;
        if (spec && !spec.loop) {
          // 终态（完成/出错）是一次性动作：演完自然回待机，别一直循环
          this.oneShot = { name: level, t: 0 };
          this.statusClip = null;
        } else {
          this.statusClip = spec ? level : null;
        }
        if (msg.text) {
          this.showBubble(String(msg.text), { level: LEVEL_STYLE[level] ?? 'info', ms: 9000 });
        }
        return;
      }

      if (msg.type === 'notice') {
        const clip = NOTICE_CLIP[msg.kind] ?? 'notice_attention';
        if (!REDUCED) this.oneShot = { name: clip, t: 0 };
        const detail = typeof msg.detail === 'string' && msg.detail ? `\n${msg.detail}` : '';
        this.showBubble(`${String(msg.text ?? '')}${detail}`, { level: msg.level ?? 'info', ms: 9000 });
      }
    }
  }

  window.DeskPet = { PetSprite };
})();
