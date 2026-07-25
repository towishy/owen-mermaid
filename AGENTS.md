# Owen Mermaid Agent Instructions

이 저장소는 Owen Mermaid 프로젝트다. Mermaid/diagram 렌더링과 Obsidian 또는 문서 시각화 흐름에 연결되는 도구로 취급한다.

## Knowledge Source

VS Code에서는 이 프로젝트와 `C:\OWEN\github\wiki`를 멀티 루트 워크스페이스로 함께 연다.

Mermaid, SVG, Obsidian, diagram validation 관련 작업은 wiki를 먼저 참조한다.

```powershell
Push-Location C:\OWEN\github\wiki
.\.venv\Scripts\python.exe scripts\wiki-query.py "Mermaid SVG diagram validation" --limit 7 --json
Pop-Location
```

## UI Direction

UI 작업 전 sibling workspace folder `wiki`의 `wiki/concepts/ui-design-system-knowledge.md`를 우선 참조한다.
디자인/프론트엔드 작업을 시작하기 전 `C:\OWEN\github\wiki\lib\ui-foundation`의 `README.md`, `DESIGN.md`, `tokens/`, `src/` 컴포넌트 계약을 읽고 현재 프로젝트에 맞게 적용한다.

기본 조합:

- Extend-UI / shadcn component structure
- Owen Graphite Liquid Glass visual surface
- Reicon for richer icon options
- Border Beam only for focused emphasis
- Boneyard only for data-heavy app skeleton loading

## Project Commands

```powershell
npm run dev
npm run build
npm run test
npm run test:obsidian
npm run release:check
```

## Local Rules

- Mermaid 출력은 SVG 표준과 충돌하지 않도록 접근성, overflow, 다크모드 이슈를 확인한다.
- 렌더링 변경은 작은 다이어그램과 긴 라벨/한글 라벨 케이스를 함께 테스트한다.
- 릴리스 전 `npm run test`와 `npm run release:check`를 우선한다.

## Localization Contract

- 사용자 노출 UI의 기본 언어는 영어(`en`)다.
- 기능을 추가하거나 변경할 때 영어와 한국어(`ko`) 문자열을 같은 변경에서 함께 구현한다. 설정, 명령, 메뉴, 버튼, tooltip, aria-label, modal, notice, 상태·오류 문구를 빠뜨리지 않는다.
- 사용자 노출 문자열을 기능 코드에 직접 하드코딩하지 않고 typed i18n catalog와 번역 함수를 사용한다.
- 내부 ID, Mermaid syntax, CSS class, 파일 경로, 사용자 데이터, 원시 오류 detail은 번역하지 않는다.
- 기본 preference는 `auto`다. Obsidian locale이 `ko` 계열이면 한국어, 그 외에는 영어를 사용하며, 사용자가 고른 `en`/`ko` override가 자동값보다 우선한다.
- 영어/한국어 key parity, 영어 fallback, 보간, 자동 locale 해석, override 우선순위를 자동 검사에 포함하고 릴리스 전에 통과시킨다.
