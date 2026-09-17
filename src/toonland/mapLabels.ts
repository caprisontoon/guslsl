/** 엔진 기본 맵 이름은 영문이라, 투네랜드 화면에 쓸 한글 이름을 따로 붙인다 */
const MAP_LABELS: Record<string, string> = {
  'Wheel of fortune': '운명의 수레바퀴',
  BubblePop: '버블팝',
  'Pot of greed': '욕망의 항아리',
  'Yoru ni Kakeru': '밤을 달리다',
};

export function mapLabel(title: string): string {
  return MAP_LABELS[title] ?? title;
}
