/**
 * 크롭 화면의 계산. canvas는 jsdom에 없으므로 "만들기"까지는 보지 않고
 * 액자 좌표 계산(선택 영역 가두기·손잡이 드래그·원본 픽셀 환산·저장 크기)만 본다.
 */
import { describe, expect, it } from 'vitest';

import {
  MIN_CROP,
  clampCrop,
  dragCrop,
  fitBox,
  saveSize,
  toSource,
  type Rect,
} from '../src/ui/cropper.ts';

const FRAME = { w: 400, h: 300 };

describe('fitBox', () => {
  it('상자 안에 contain으로 넣는다', () => {
    expect(fitBox(800, 600, 400, 400)).toEqual({ w: 400, h: 300 });
    expect(fitBox(600, 800, 400, 400)).toEqual({ w: 300, h: 400 });
  });
  it('상자나 그림이 0이면 0이다', () => {
    expect(fitBox(0, 0, 400, 400)).toEqual({ w: 0, h: 0 });
    expect(fitBox(800, 600, 0, 400)).toEqual({ w: 0, h: 0 });
  });
});

describe('clampCrop', () => {
  it('액자 밖으로 나가면 안으로 밀어 넣는다', () => {
    expect(clampCrop({ x: -50, y: -50, w: 100, h: 100 }, FRAME)).toEqual({ x: 0, y: 0, w: 100, h: 100 });
    expect(clampCrop({ x: 380, y: 280, w: 100, h: 100 }, FRAME)).toEqual({ x: 300, y: 200, w: 100, h: 100 });
  });
  it('액자보다 큰 선택은 액자 크기로 자른다', () => {
    expect(clampCrop({ x: 0, y: 0, w: 900, h: 900 }, FRAME)).toEqual({ x: 0, y: 0, w: 400, h: 300 });
  });
  it('최소 변보다 작아지지 않는다', () => {
    expect(clampCrop({ x: 10, y: 10, w: 2, h: 2 }, FRAME)).toEqual({
      x: 10,
      y: 10,
      w: MIN_CROP,
      h: MIN_CROP,
    });
  });
  it('액자가 최소 변보다 좁으면 액자에 맞춘다', () => {
    expect(clampCrop({ x: 0, y: 0, w: 1, h: 1 }, { w: 8, h: 8 })).toEqual({ x: 0, y: 0, w: 8, h: 8 });
  });
});

describe('dragCrop', () => {
  const start: Rect = { x: 100, y: 80, w: 200, h: 150 };

  it('안쪽을 끌면 크기는 그대로 옮긴다', () => {
    expect(dragCrop(start, 'move', 30, -20, FRAME)).toEqual({ x: 130, y: 60, w: 200, h: 150 });
  });
  it('옮기다 액자에 닿으면 거기서 멈춘다', () => {
    expect(dragCrop(start, 'move', 900, 900, FRAME)).toEqual({ x: 200, y: 150, w: 200, h: 150 });
    expect(dragCrop(start, 'move', -900, -900, FRAME)).toEqual({ x: 0, y: 0, w: 200, h: 150 });
  });
  it('모서리는 마주 보는 꼭짓점을 붙박아 둔 채 늘고 준다', () => {
    expect(dragCrop(start, 'se', 50, 50, FRAME)).toEqual({ x: 100, y: 80, w: 250, h: 200 });
    expect(dragCrop(start, 'nw', 50, 50, FRAME)).toEqual({ x: 150, y: 130, w: 150, h: 100 });
    expect(dragCrop(start, 'ne', 20, -30, FRAME)).toEqual({ x: 100, y: 50, w: 220, h: 180 });
  });
  it('변 손잡이는 한 방향만 바꾼다', () => {
    expect(dragCrop(start, 'e', -40, 999, FRAME)).toEqual({ x: 100, y: 80, w: 160, h: 150 });
    expect(dragCrop(start, 'n', 999, 40, FRAME)).toEqual({ x: 100, y: 120, w: 200, h: 110 });
  });
  it('손잡이는 액자를 넘지 않고 최소 변에서 멈춘다', () => {
    expect(dragCrop(start, 'se', 999, 999, FRAME)).toEqual({ x: 100, y: 80, w: 300, h: 220 });
    expect(dragCrop(start, 'e', -999, 0, FRAME)).toEqual({ x: 100, y: 80, w: MIN_CROP, h: 150 });
    expect(dragCrop(start, 'w', 999, 0, FRAME)).toEqual({ x: 300 - MIN_CROP, y: 80, w: MIN_CROP, h: 150 });
  });
});

describe('toSource', () => {
  it('액자 좌표를 원본 픽셀로 옮긴다', () => {
    // 액자 400×300에 원본 800×600 → 두 배
    expect(toSource({ x: 50, y: 25, w: 100, h: 50 }, FRAME, { w: 800, h: 600 })).toEqual({
      x: 100,
      y: 50,
      w: 200,
      h: 100,
    });
  });
  it('원본 밖으로는 나가지 않는다', () => {
    expect(toSource({ x: 0, y: 0, w: 400, h: 300 }, FRAME, { w: 800, h: 600 })).toEqual({
      x: 0,
      y: 0,
      w: 800,
      h: 600,
    });
  });
});

describe('saveSize', () => {
  it('4000 아래는 그대로', () => {
    expect(saveSize(1920, 1080)).toEqual({ w: 1920, h: 1080 });
  });
  it('긴 변이 4000을 넘으면 거기에 맞춰 줄인다', () => {
    expect(saveSize(8000, 4000)).toEqual({ w: 4000, h: 2000 });
    expect(saveSize(2000, 6000)).toEqual({ w: 1333, h: 4000 });
  });
  it('세로 한계도 지킨다', () => {
    expect(saveSize(100, 50, 40)).toEqual({ w: 40, h: 20 });
  });
});
