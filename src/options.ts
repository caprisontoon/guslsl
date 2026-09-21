export type WinnerRange = { start: number; end: number };

class Options {
  /**
   * 구슬 스킬(주변을 밀어내는 임팩트). 이 게임에서는 끈다.
   *
   * 두 가지 이유다.
   *  - 구슬 100개에서는 초당 20번쯤 터진다(구슬당 1초에 20% 확률). 한 번에 반경 10
   *    안의 구슬을 전부 밀어내므로 판이 계속 흔들려 구슬 같지 않게 움직인다.
   *    원래 6~30개로 놀던 게임이라 그때는 가끔 터지는 연출이었다.
   *  - 스킬은 물리를 바꾼다. 시드 풀은 특정 설정으로 미리 계산해 둔 것이라, 이 값이
   *    달라지면 서버가 아는 1등과 화면이 어긋난다(시드 6개 전부 달라지는 것을 확인).
   *    그래서 사용자가 켜고 끌 수 있는 값이면 안 된다.
   */
  useSkills: boolean = false;
  /** 0-based, 양끝 포함. 1명 추첨은 start === end */
  winnerRange: WinnerRange = { start: 0, end: 0 };
  autoRecording: boolean = true;
}

const options = new Options();
export default options;
