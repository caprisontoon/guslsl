import type { StageDef } from './data/maps';
import type { MapEntityState } from './types/MapEntity.type';

export interface IPhysics {
  init(): Promise<void>;

  clear(): void;

  /** 월드를 통째로 새로 만든다. 판 사이에 직전 결과가 새지 않게 한다 */
  resetWorld(): void;

  clearMarbles(): void;

  createStage(stage: StageDef): void;

  createMarble(id: number, x: number, y: number, density: number): void;

  shakeMarble(id: number, impulseX: number, impulseY: number): void;

  removeMarble(id: number): void;

  getMarblePosition(id: number): { x: number; y: number; angle: number };

  getEntities(): MapEntityState[];

  impact(id: number): void;

  start(): void;

  step(deltaSeconds: number): void;
}
