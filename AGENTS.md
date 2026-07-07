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
