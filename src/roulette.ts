import { Camera } from './camera';
import { canvasHeight, canvasWidth, initialZoom, Skills, Themes, zoomThreshold } from './data/constants';
import { type StageDef, stages } from './data/maps';
import { FastForwader } from './fastForwader';
import type { GameObject } from './gameObject';
import type { IPhysics } from './IPhysics';
import { Marble } from './marble';
import { Minimap } from './minimap';
import options, { type WinnerRange } from './options';
import { ParticleManager } from './particleManager';
import { Box2dPhysics } from './physics-box2d';
import { RankRenderer } from './rankRenderer';
import { RouletteRenderer } from './rouletteRenderer';
import { SkillEffect } from './skillEffect';
import type { ColorTheme } from './types/ColorTheme';
import type { MouseEventHandlerName, MouseEventName } from './types/mouseEvents.type';
import type { UIObject } from './UIObject';
import { bound } from './utils/bound.decorator';
import { deriveSeed } from './utils/rng';
import { VideoRecorder } from './utils/videoRecorder';

/** 출발 칸 하나에 놓을 구슬. 색으로 상품 등급을 구분해 어느 구슬이 값진지 보이게 한다 */
export type MarbleSpec = {
  label: string;
  hue: number;
  /** 꽝 구슬. 회색으로 죽이고 이름을 그리지 않는다 */
  muted?: boolean;
};

/** 입력 범위를 실제 구슬 수에 맞춰 자른다. 범위를 넘기면 뒤쪽이 잘린다 */
function clipWinnerRange({ start, end }: WinnerRange, marbleCount: number): WinnerRange {
  const last = Math.max(0, marbleCount - 1);
  const clippedStart = Math.min(Math.max(0, start), last);
  return { start: clippedStart, end: Math.min(Math.max(clippedStart, end), last) };
}

export class Roulette extends EventTarget {
  private _marbles: Marble[] = [];

  private _lastTime: number = 0;
  private _elapsed: number = 0;

  private _updateInterval = 10;
  private _timeScale = 1;
  private _speed = 1;

  private _winners: Marble[] = [];
  private _particleManager = new ParticleManager();
  private _stage: StageDef | null = null;

  protected _camera: Camera = new Camera();
  protected _renderer: RouletteRenderer;

  private _effects: GameObject[] = [];

  private _winnerRange: WinnerRange = { start: 0, end: 0 };
  private _goalDist: number = Infinity;
  private _isRunning: boolean = false;
  /**
   * 물리를 진행시킬지. 대기 중에는 멈춰 둔다.
   *
   * 맵에는 계속 도는 장치가 있어서, 대기 중에도 스텝을 돌리면 출발 시각까지 흐른
   * 프레임 수만큼 판이 돌아가 있다. 그러면 같은 시드라도 서버가 예측한 1등과
   * 다른 구슬이 들어온다. start() 시점의 판 상태를 항상 같게 만들어야 한다
   */
  private _stepping: boolean = false;
  /** 진행 중에는 null, 당첨자가 모두 확정되면 당첨자 배열 */
  private _result: Marble[] | null = null;

  // 구슬 id(= order)는 매 라운드 재사용된다. 리셋 시 취소하지 않으면 이 타이머가
  // 뒤늦게 발화해 같은 id를 가진 새 라운드의 구슬을 지워버린다
  private _pendingRemovals: number[] = [];

  private _uiObjects: UIObject[] = [];

  private _autoRecording: boolean = false;
  private _recorder!: VideoRecorder;

  private physics!: IPhysics;

  private _isReady: boolean = false;
  protected fastForwarder!: FastForwader;
  protected _theme: ColorTheme = Themes.dark;

  get isReady() {
    return this._isReady;
  }

  protected createRenderer(): RouletteRenderer {
    return new RouletteRenderer();
  }

  protected createFastForwader(): FastForwader {
    return new FastForwader();
  }

  constructor() {
    super();
    this._renderer = this.createRenderer();
    this._renderer.init().then(() => {
      this._init().then(() => {
        this._isReady = true;
        this._update();
      });
    });
  }

  public getZoom() {
    return initialZoom * this._camera.zoom;
  }

  private addUiObject(obj: UIObject) {
    this._uiObjects.push(obj);
    if (obj.onWheel) {
      this._renderer.canvas.addEventListener('wheel', obj.onWheel);
    }
    if (obj.onMessage) {
      obj.onMessage((msg) => {
        console.log('onMessage', msg);
        this.dispatchEvent(new CustomEvent('message', { detail: msg }));
      });
    }
  }

  @bound
  private _update() {
    if (!this._lastTime) this._lastTime = Date.now();
    const currentTime = Date.now();

    this._elapsed += (currentTime - this._lastTime) * this._speed * this.fastForwarder.speed;
    if (this._elapsed > 100) {
      this._elapsed %= 100;
    }
    this._lastTime = currentTime;

    // 스텝 크기와 정렬을 프레임이 아니라 스텝마다 정한다. 프레임 하나에 스텝이 몇 번
    // 도는지는 기기 성능에 따라 달라지므로, 프레임 단위로 잡으면 같은 시드라도 결과가
    // 갈린다. 스텝 단위로 두면 n 번째 스텝의 상태가 프레임 경계와 무관하게 같아진다.
    // 구슬 정지 판정도 물리 스텝과 같은 timeScale 을 써야 진행된 물리 시간과 맞는다
    while (this._stepping && this._elapsed >= this._updateInterval) {
      const timeScale = this._timeScale;
      this.physics.step((this._updateInterval / 1000) * timeScale);
      if (this._marbles.length > 1) {
        this._marbles.sort((a, b) => b.y - a.y);
      }
      this._updateMarbles(this._updateInterval, timeScale);
      this._particleManager.update(this._updateInterval);
      this._updateEffects(this._updateInterval);
      this._elapsed -= this._updateInterval;
      this._uiObjects.forEach((obj) => obj.update(this._updateInterval));
    }

    if (this._stage) {
      this._camera.update({
        marbles: this._marbles,
        stage: this._stage,
        needToZoom: this._goalDist < zoomThreshold,
        targetIndex: this._winners.length > 0 ? this._targetIndex : 0,
      });
    }

    this._render();
    window.requestAnimationFrame(this._update);
  }

  private _updateMarbles(deltaTime: number, timeScale: number) {
    if (!this._stage) return;

    for (let i = 0; i < this._marbles.length; i++) {
      const marble = this._marbles[i];
      marble.update(deltaTime, timeScale);
      if (marble.skill === Skills.Impact) {
        this._effects.push(new SkillEffect(marble.x, marble.y));
        this.physics.impact(marble.id);
      }
      if (marble.y > this._stage.goalY) {
        this._winners.push(marble);
        if (this._isRunning && this._isWinningRank(this._winners.length - 1)) {
          this._particleManager.shot(this._renderer.width, this._renderer.height);
        }
        this._pendingRemovals.push(
          window.setTimeout(() => {
            this.physics.removeMarble(marble.id);
          }, 500)
        );
      }
    }

    const targetIndex = this._targetIndex;
    const topY = this._marbles[targetIndex] ? this._marbles[targetIndex].y : 0;
    this._goalDist = Math.abs(this._stage.zoomY - topY);
    this._timeScale = this._calcTimeScale();

    const goalY = this._stage.goalY;
    this._marbles = this._marbles.filter((marble) => marble.y <= goalY);

    this._checkFinish();
  }

  /** 카메라와 슬로우모션이 주목할 구슬 = 당첨 커트라인에 걸쳐있는 구슬 */
  private get _targetIndex() {
    return this._winnerRange.end - this._winners.length;
  }

  private _isWinningRank(rank: number) {
    return rank >= this._winnerRange.start && rank <= this._winnerRange.end;
  }

  private _checkFinish() {
    if (!this._isRunning) return;
    const { start, end } = this._winnerRange;

    // 남은 구슬이 1개면 그 등수는 골인하지 않아도 확정된다. 2개 이상 남았다면 그들 사이의
    // 순위는 물리로만 정해지므로 예측하지 않는다 (당첨 범위 안에서도 순위는 의미를 가진다)
    const early = this._winners.length > 0 && this._marbles.length === 1;
    const ranked = early ? [...this._winners, this._marbles[0]] : this._winners;
    if (ranked.length <= end) return;

    if (early && this._isWinningRank(this._winners.length)) {
      this._particleManager.shot(this._renderer.width, this._renderer.height);
    }

    this._result = ranked.slice(start, end + 1);
    this._isRunning = false;
    this.dispatchEvent(
      new CustomEvent('goal', {
        detail: {
          winner: this._result[0].name,
          // 출발 칸 번호. 같은 이름의 구슬이 여럿이라 이름만으로는 특정할 수 없다
          winnerSlot: this._result[0].id,
          winners: this._result.map((m) => m.name),
        },
      })
    );
    setTimeout(() => {
      this._recorder.stop();
    }, 1000);
  }

  private _calcTimeScale(): number {
    if (!this._stage) return 1;
    const targetIndex = this._targetIndex;
    if (this._winners.length < this._winnerRange.end + 1 && this._goalDist < zoomThreshold) {
      if (
        this._marbles[targetIndex].y > this._stage.zoomY - zoomThreshold * 1.2 &&
        (this._marbles[targetIndex - 1] || this._marbles[targetIndex + 1])
      ) {
        return Math.max(0.2, this._goalDist / zoomThreshold);
      }
    }
    return 1;
  }

  private _updateEffects(deltaTime: number) {
    this._effects.forEach((effect) => effect.update(deltaTime));
    this._effects = this._effects.filter((effect) => !effect.isDestroy);
  }

  private _render() {
    if (!this._stage) return;
    const renderParams = {
      camera: this._camera,
      stage: this._stage,
      entities: this.physics.getEntities(),
      marbles: this._marbles,
      winners: this._winners,
      particleManager: this._particleManager,
      effects: this._effects,
      winnerRange: this._winnerRange,
      result: this._result,
      size: { x: this._renderer.width, y: this._renderer.height },
      theme: this._theme,
    };
    this._renderer.render(renderParams, this._uiObjects);
  }

  private async _init() {
    this._recorder = new VideoRecorder(this._renderer.canvas);

    this.physics = new Box2dPhysics();
    await this.physics.init();

    this.addUiObject(new RankRenderer());
    this.attachEvent();
    const minimap = new Minimap();
    minimap.onViewportChange((pos) => {
      if (pos) {
        this._camera.setPosition(pos, false);
        this._camera.lock(true);
      } else {
        this._camera.lock(false);
      }
    });
    this.addUiObject(minimap);
    this.fastForwarder = this.createFastForwader();
    this.addUiObject(this.fastForwarder);
    this._stage = stages[0];
    this._loadMap();
  }

  @bound
  private mouseHandler(eventName: MouseEventName, e: MouseEvent) {
    const handlerName = `on${eventName}` as MouseEventHandlerName;

    const sizeFactor = this._renderer.sizeFactor;
    const pos = { x: e.offsetX * sizeFactor, y: e.offsetY * sizeFactor };
    this._uiObjects.forEach((obj) => {
      if (!obj[handlerName]) return;
      const bounds = obj.getBoundingBox();
      if (!bounds) {
        obj[handlerName]({ ...pos, button: e.button });
      } else if (
        bounds &&
        pos.x >= bounds.x &&
        pos.y >= bounds.y &&
        pos.x <= bounds.x + bounds.w &&
        pos.y <= bounds.y + bounds.h
      ) {
        obj[handlerName]({ x: pos.x - bounds.x, y: pos.y - bounds.y, button: e.button });
      } else {
        obj[handlerName](undefined);
      }
    });
  }

  private attachEvent() {
    const canvas = this._renderer.canvas;
    const onPointerRelease = (e: Event) => {
      this.mouseHandler('MouseUp', e as MouseEvent);
      window.removeEventListener('pointerup', onPointerRelease);
      window.removeEventListener('pointercancel', onPointerRelease);
    };

    canvas.addEventListener('pointerdown', (e: Event) => {
      this.mouseHandler('MouseDown', e as MouseEvent);
      window.addEventListener('pointerup', onPointerRelease);
      window.addEventListener('pointercancel', onPointerRelease);
    });

    ['MouseMove', 'DblClick'].forEach((ev) => {
      // @ts-expect-error
      canvas.addEventListener(ev.toLowerCase().replace('mouse', 'pointer'), this.mouseHandler.bind(this, ev));
    });
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });

    canvas.addEventListener('click', (e) => {
      if (this.resultCloseHitAt(e)) {
        this._renderer.closeResultPopup();
      }
    });

    canvas.addEventListener('pointermove', (e) => {
      canvas.style.cursor = this.resultCloseHitAt(e) ? 'pointer' : '';
    });
  }

  private _loadMap() {
    if (!this._stage) {
      throw new Error('No map has been selected');
    }

    this.physics.createStage(this._stage);
    this._camera.initializePosition();
  }

  public clearMarbles() {
    this._pendingRemovals.forEach((id) => window.clearTimeout(id));
    this._pendingRemovals = [];
    this.physics.clearMarbles();
    this._result = null;
    this._winners = [];
    this._marbles = [];
  }

  public async startRecording() {
    if (!this._autoRecording) return;
    try {
      await this._recorder.start();
    } catch (e) {
      console.error('recording failed to start', e);
    }
  }

  public start() {
    this._isRunning = true;
    // 대기 중 쌓인 시간은 버린다. 첫 프레임에 스텝이 몰려도 결과는 같지만,
    // 출발 직후 화면이 튀어 보인다
    this._elapsed = 0;
    this._lastTime = Date.now();
    this._stepping = true;
    this._winnerRange = clipWinnerRange(options.winnerRange, this._marbles.length);
    this._camera.startFollowingMarbles();

    if (this._autoRecording) {
      this._recorder.start().then(() => {
        this.physics.start();
        this._marbles.forEach((marble) => (marble.isActive = true));
      });
    } else {
      this.physics.start();
      this._marbles.forEach((marble) => (marble.isActive = true));
    }
  }

  public setSpeed(value: number) {
    if (value <= 0) {
      throw new Error('Speed multiplier must larger than 0');
    }
    this._speed = value;
  }

  private resultCloseHitAt(e: MouseEvent): boolean {
    const sizeFactor = this._renderer.sizeFactor;
    return this._renderer.getResultCloseHitAt(e.offsetX * sizeFactor, e.offsetY * sizeFactor);
  }

  public setTheme(themeName: keyof typeof Themes) {
    this._theme = Themes[themeName];
  }

  public getSpeed() {
    return this._speed;
  }

  public setWinningRank(rank: number) {
    this.setWinnerRange(rank, rank);
  }

  public setWinnerRange(start: number, end: number) {
    options.winnerRange = { start, end };
    this._winnerRange = clipWinnerRange(options.winnerRange, this._marbles.length);
  }

  /** 실제 구슬 수에 맞춰 잘린 범위 (0-based, 양끝 포함) */
  public getWinnerRange(): WinnerRange {
    return { ...this._winnerRange };
  }

  public setAutoRecording(value: boolean) {
    this._autoRecording = value;
  }

  /**
   * 출발선에 구슬을 놓는다. specs[i] 가 i 번 칸의 구슬이다.
   *
   * 칸 배정은 섞지 않는다. 어느 칸에 어떤 상품을 놓을지는 서버가 정해서 내려주기
   * 때문이다. seed 를 주면 구슬마다 그 시드에서 파생한 난수 수열을 써서, 같은
   * (시드, 구슬 수, 맵) 이면 언제 어디서 돌려도 같은 구슬이 1등한다.
   */
  public setMarbles(specs: MarbleSpec[], seed?: number) {
    this.reset();

    const totalCount = specs.length;
    specs.forEach((spec, order) => {
      const marbleSeed = seed === undefined ? undefined : deriveSeed(seed, order);
      this._marbles.push(
        new Marble(this.physics, order, totalCount, spec.label, 1, marbleSeed, {
          hue: spec.hue,
          muted: spec.muted,
        })
      );
    });

    // 카메라를 구슬 생성 위치 중앙으로 이동 + 줌인
    if (totalCount > 0) {
      const cols = Math.min(totalCount, 10);
      const rows = Math.ceil(totalCount / 10);
      const lineDelta = -Math.max(0, Math.ceil(rows - 5));
      const centerX = 10.25 + (cols - 1) * 0.3;
      const centerY = (1 + rows) / 2 + lineDelta;

      const spawnWidth = Math.max((cols - 1) * 0.6, 1);
      const spawnHeight = Math.max(rows - 1, 1);
      const margin = 3;
      const viewW = canvasWidth / initialZoom;
      const viewH = canvasHeight / initialZoom;
      const zoom = Math.max(
        1.5,
        Math.min(Math.min(viewW / (spawnWidth + margin * 2), viewH / (spawnHeight + margin * 2)), 3)
      );

      this._camera.initializePosition({ x: centerX, y: centerY }, zoom);
    }
  }

  public reset() {
    this._stepping = false;
    this._pendingRemovals.forEach((id) => window.clearTimeout(id));
    this._pendingRemovals = [];
    this._result = null;
    this._winners = [];
    this._marbles = [];
    // 판마다 빈 월드에서 시작해야 같은 시드가 같은 1등을 낸다
    this.physics.resetWorld();
    this._loadMap();
    this._goalDist = Infinity;
  }

  public getCount() {
    return this._marbles.length;
  }

  public getMaps() {
    return stages.map((stage, index) => {
      return {
        index,
        title: stage.title,
      };
    });
  }

  public getCurrentMap() {
    if (!this._stage) return null;
    return {
      index: stages.indexOf(this._stage),
      title: this._stage.title,
    };
  }

  public setMap(index: number) {
    if (index < 0 || index > stages.length - 1) {
      throw new Error('Incorrect map number');
    }
    const specs: MarbleSpec[] = this._marbles.map((marble) => ({
      label: marble.name,
      hue: marble.hue,
      muted: marble.muted,
    }));
    this._stage = stages[index];
    this.setMarbles(specs);
    this._camera.initializePosition();
  }
}
