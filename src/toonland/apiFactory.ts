import { type GameApi, LocalGameApi } from './api';
import { ToonationGameApi } from './httpApi';

function meta(name: string): string | null {
  const value = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content?.trim();
  return value ? value : null;
}

export type ApiMode = 'server' | 'demo';

export type CreatedApi = {
  api: GameApi;
  mode: ApiMode;
  /** 캐시 충전 페이지 주소. <meta name="toonland-charge-url"> 로 지정 */
  chargeUrl?: string;
};

/**
 * 어느 백엔드에 붙을지는 HTML 의 메타 태그가 정한다. 투네이션 페이지에서 서버가
 * 이 태그를 심어주면 실서버로, 태그가 없으면 브라우저 저장소로 도는 시연 모드다.
 *
 *   <meta name="toonland-api-base" content="/api/toonland/race">
 *   <meta name="toonland-admin-api-base" content="/api/admin/toonland/race">
 *   <meta name="toonland-api-credentials" content="include">   <!-- 세션 쿠키 인증 -->
 *
 * 빌드를 다시 하지 않고 배포 환경마다 바꿀 수 있어서 환경변수보다 편하다.
 */
export function createGameApi(): CreatedApi {
  const baseUrl = meta('toonland-api-base');
  if (!baseUrl) {
    console.warn(
      '[강냉이 레이스] 시연 모드입니다. 강냉이와 상품이 브라우저에만 저장되고 서버에 반영되지 않습니다.\n' +
        '실서버에 붙이려면 <meta name="toonland-api-base" content="..."> 를 넣으세요.'
    );
    return { api: new LocalGameApi(), mode: 'demo' };
  }

  return {
    api: new ToonationGameApi({
      baseUrl,
      adminBaseUrl: meta('toonland-admin-api-base') ?? undefined,
      // 도네이터 로그인 세션을 그대로 쓰는 경우가 많아 기본값을 include 로 둔다
      credentials: (meta('toonland-api-credentials') as RequestCredentials | null) ?? 'include',
    }),
    mode: 'server',
    chargeUrl: meta('toonland-charge-url') ?? undefined,
  };
}
